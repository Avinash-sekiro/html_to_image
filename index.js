const fastify = require("fastify")({ 
  logger: true,
  bodyLimit: 10485760 // 10MB limit
});
const { createClient } = require("@supabase/supabase-js");
const { createClient: createRedisClient } = require("redis");
const nodeHtmlToImage = require("node-html-to-image");
require("dotenv").config();

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Redis setup
const redis = createRedisClient({
  url: "redis://default:2LNEtD35z5Fzji5adNJifJccs4ClKG4LSKRNdQnQam1Nd6nj1hfuatteBiILfEKc@i4w8kc04g8ok8840k4w0w8ok:6379/0"
});
redis.connect().catch(console.error);
redis.on('error', err => console.error('Redis Client Error:', err));
redis.on('connect', () => console.log('✅ Connected to Redis'));

// Helper function to filter cached data
function filterData(data, filters) {
  if (!filters || Object.keys(filters).length === 0) return data;
  return data.filter(item =>
    Object.entries(filters).every(([column, value]) => {
      if (typeof value === 'object' && value !== null) {
        const { operator, value: filterValue } = value;
        switch (operator) {
          case 'eq': return item[column] == filterValue;
          case 'neq': return item[column] != filterValue;
          case 'gt': return item[column] > filterValue;
          case 'gte': return item[column] >= filterValue;
          case 'lt': return item[column] < filterValue;
          case 'lte': return item[column] <= filterValue;
          case 'like': return String(item[column]).includes(filterValue);
          case 'ilike': return String(item[column]).toLowerCase().includes(filterValue.toLowerCase());
          case 'in': return filterValue.includes(item[column]);
          default: return item[column] == filterValue;
        }
      } else {
        return item[column] == value;
      }
    })
  );
}

// ---------- ROUTE 1: Convert HTML to Image ----------
fastify.post("/html-to-image", async (request, reply) => {
  try {
    const { html } = request.body;
    if (!html) return reply.status(400).send({ error: "html field is required" });
    
    const image = await nodeHtmlToImage({
      html,
      puppeteerArgs: {
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu"
        ]
      },
      encoding: "buffer"
    });
    
    reply.header("Content-Type", "image/png");
    return reply.send(image);
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

// ---------- ROUTE 2: Prompt Query Like SQL Required ----------
fastify.post("/prompt", async (request, reply) => {
  try {
    const { activity_id, current_slide } = request.body;
    if (!activity_id || typeof current_slide === "undefined")
      return reply.status(400).send({ error: "activity_id and current_slide are required" });

    const tableCacheKey = "public.prompt_table:ALL_DATA";
    let allData = null;
    const cachedAllData = await redis.get(tableCacheKey);

    if (cachedAllData) {
      console.log("Cache hit ✅ - Filtering from cached data");
      allData = JSON.parse(cachedAllData);
    } else {
      // Fetch all data from Supabase
      console.log("Cache miss ❌ - Fetching ALL prompt_table from Supabase...");
      const { data, error } = await supabase
        .schema("public")
        .from("prompt_table")
        .select("*");

      if (error) throw error;
      allData = data;
      await redis.setEx(tableCacheKey, 600, JSON.stringify(allData));
      console.log(`All prompt_table cached ✅ - ${allData.length} records`);
    }

    // Filter for activity_id
    const filteredRows = filterData(allData, { activity_id: activity_id });

    // Map to result like your SQL
    const results = filteredRows.map(row => {
      let promptPicContent = "";
      if (Array.isArray(row.prompt_pic)) {
        // Is JSONB array
        promptPicContent = (row.prompt_pic && row.prompt_pic[current_slide]) || "";
      } else if (typeof row.prompt_pic === "object" && row.prompt_pic !== null) {
        // If array stored as object (happens with Postgres+supabase sometimes)
        promptPicContent = row.prompt_pic[current_slide] || "";
      } else {
        promptPicContent = row.prompt_pic ? String(row.prompt_pic) : "";
      }

      return {
        full_prompt: 
          (row.pre_prompt || "") + " " +
          promptPicContent + " " +
          (row.post_prompt || ""),
        model_number: row.model_number
      };
    });

    reply.send({
      from: cachedAllData ? "redis_filtered" : "supabase_fetched",
      data: results,
      filtered_records: results.length
    });
  } catch (err) {
    console.error("Prompt route error:", err);
    return reply.status(500).send({ error: err.message });
  }
});

// ---------- ROUTE 3: Smart Cache Query (Cache ALL, Filter Locally) ----------
fastify.post("/query", async (request, reply) => {
  try {
    const { table, schema = "prompt_info", filters = {}, columns = "*" } = request.body;
    if (!table) return reply.status(400).send({ error: "Table name is required" });

    // Cache key for the ENTIRE table (without filters)
    const tableCacheKey = `${schema}.${table}:ALL_DATA`;
    
    // Check if we have ALL data cached
    const cachedAllData = await redis.get(tableCacheKey);
    
    if (cachedAllData) {
      console.log("Cache hit ✅ - Filtering from cached data");
      const allData = JSON.parse(cachedAllData);
      const filteredData = filterData(allData, filters);
      
      return reply.send({ 
        from: "redis_filtered", 
        data: filteredData,
        total_cached_records: allData.length,
        filtered_records: filteredData.length
      });
    }

    console.log("Cache miss ❌ - Fetching ALL data from Supabase...");
    
    // Build query for ALL data (ignore filters for now)
    let query;
    if (schema && schema !== "public") {
      query = supabase.schema(schema).from(table).select(columns);
    } else {
      query = supabase.from(table).select(columns);
    }

    // Get ALL data from the table
    const { data: allData, error: queryError } = await query;
    
    if (queryError) {
      console.error("Query error:", queryError);
      throw queryError;
    }

    // If no data found, try fallback
    if (!allData || allData.length === 0) {
      console.log("No data found, running fallback query...");
      
      const { data: fallbackData, error: fallbackError } = await supabase
        .schema("prompt_info")
        .from("activity_prompts")
        .select("*");

      if (fallbackError) {
        console.error("Fallback query error:", fallbackError);
        throw fallbackError;
      }

      // Cache fallback data
      const fallbackCacheKey = "prompt_info.activity_prompts:ALL_DATA";
      await redis.setEx(fallbackCacheKey, 600, JSON.stringify(fallbackData)); // 10 minutes
      console.log("Fallback data cached ✅");

      // Filter fallback data and return
      const filteredFallbackData = filterData(fallbackData, filters);
      
      return reply.send({ 
        from: "supabase_fallback_filtered", 
        data: filteredFallbackData,
        fallback_executed: true,
        total_fallback_records: fallbackData.length,
        filtered_records: filteredFallbackData.length
      });
    }

    // Cache ALL data for future queries (10 minutes TTL)
    await redis.setEx(tableCacheKey, 600, JSON.stringify(allData));
    console.log(`All data cached ✅ - ${allData.length} records`);

    // Filter the data based on request filters
    const filteredData = filterData(allData, filters);

    return reply.send({ 
      from: "supabase_cached_filtered", 
      data: filteredData,
      total_records: allData.length,
      filtered_records: filteredData.length,
      cache_populated: true
    });

  } catch (err) {
    console.error("Query route error:", err);
    return reply.status(500).send({ error: err.message });
  }
});

// ---------- ROUTE 4: Direct activity_id Query (Uses Smart Cache) ----------
fastify.get("/activity/:id", async (request, reply) => {
  try {
    const { id } = request.params;
    const activityId = parseInt(id);
    
    // Use the smart cache system
    const tableCacheKey = "prompt_info.activity_prompts:ALL_DATA";
    const cachedAllData = await redis.get(tableCacheKey);
    
    if (cachedAllData) {
      console.log("Cache hit ✅ - Finding activity_id from cached data");
      const allData = JSON.parse(cachedAllData);
      const activityData = allData.filter(item => item.activity_id === activityId);
      
      return reply.send({ 
        from: "redis_filtered", 
        data: activityData,
        activity_id: activityId,
        found: activityData.length > 0
      });
    }

    // If no cache, fetch all data first
    console.log("Cache miss ❌ - Fetching all activity_prompts...");
    const { data: allData, error } = await supabase
      .schema("prompt_info")
      .from("activity_prompts")
      .select("*");

    if (error) throw error;

    // Cache all data
    await redis.setEx(tableCacheKey, 600, JSON.stringify(allData));
    console.log(`All activity_prompts cached ✅ - ${allData.length} records`);

    // Filter for specific activity_id
    const activityData = allData.filter(item => item.activity_id === activityId);

    return reply.send({ 
      from: "supabase_cached_filtered", 
      data: activityData,
      activity_id: activityId,
      found: activityData.length > 0,
      total_records: allData.length
    });

  } catch (err) {
    console.error("Activity route error:", err);
    return reply.status(500).send({ error: err.message });
  }
});

// ---------- ROUTE 5: SQL Query Support ----------
fastify.post("/sql-query", async (request, reply) => {
  try {
    const { sql } = request.body;
    if (!sql) return reply.status(400).send({ error: "SQL query is required" });
    
    const normalizedSql = sql.toLowerCase().trim();

    if (normalizedSql.startsWith("select * from prompt_table")) {
      // Use smart cache for prompt_table
      const tableCacheKey = "public.prompt_table:ALL_DATA";
      const cachedAllData = await redis.get(tableCacheKey);
      
      if (cachedAllData) {
        console.log("Cache hit ✅ - Returning all prompt_table data");
        return reply.send({ 
          from: "redis", 
          data: JSON.parse(cachedAllData),
          sql_parsed: true 
        });
      }

      // Fetch all data
      const { data, error } = await supabase
        .schema("public")
        .from("prompt_table")
        .select("*");

      if (error) throw error;

      // Cache all data
      await redis.setEx(tableCacheKey, 600, JSON.stringify(data));
      
      return reply.send({ 
        from: "supabase_cached", 
        data, 
        sql_parsed: true,
        cached_records: data.length
      });
    }

    return reply.status(400).send({ 
      error: "Direct SQL not supported. Use /query endpoint.",
      example: {
        table: "activity_prompts",
        schema: "prompt_info",
        filters: { activity_id: 1 }
      }
    });
  } catch (err) {
    console.error("SQL query error:", err);
    return reply.status(500).send({ error: err.message });
  }
});

// ---------- ROUTE 6: Users ----------
fastify.get("/users", async (request, reply) => {
  try {
    const cacheKey = "users";
    const cached = await redis.get(cacheKey);
    if (cached) return reply.send({ from: "redis", data: JSON.parse(cached) });
    
    const { data, error } = await supabase.from("users").select("*");
    if (error) throw error;
    
    await redis.setEx(cacheKey, 120, JSON.stringify(data));
    return reply.send({ from: "supabase", data });
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

// ---------- ROUTE 7: User by ID ----------
fastify.get("/users/:id", async (request, reply) => {
  try {
    const { id } = request.params;
    const cacheKey = `user:${id}`;
    const cached = await redis.get(cacheKey);
    if (cached) return reply.send({ from: "redis", data: JSON.parse(cached) });
    
    const { data, error } = await supabase.from("users").select("*").eq("id", id).single();
    if (error) throw error;
    
    await redis.setEx(cacheKey, 120, JSON.stringify(data));
    return reply.send({ from: "supabase", data });
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

// ---------- ROUTE 8: All Activity Prompts ----------
fastify.get("/activity-prompts", async (request, reply) => {
  try {
    const tableCacheKey = "prompt_info.activity_prompts:ALL_DATA";
    const cached = await redis.get(tableCacheKey);
    if (cached) return reply.send({ from: "redis", data: JSON.parse(cached) });
    
    const { data, error } = await supabase.schema("prompt_info").from("activity_prompts").select("*");
    if (error) throw error;
    
    await redis.setEx(tableCacheKey, 600, JSON.stringify(data));
    return reply.send({ from: "supabase", data, cached_records: data.length });
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

// ---------- ROUTE 9: Cache Stats ----------
fastify.get("/cache-stats", async (request, reply) => {
  try {
    const keys = await redis.keys("*:ALL_DATA");
    const stats = {};
    
    for (const key of keys) {
      const data = await redis.get(key);
      const ttl = await redis.ttl(key);
      if (data) {
        const parsedData = JSON.parse(data);
        stats[key] = {
          records: parsedData.length,
          ttl_seconds: ttl,
          size_kb: Math.round(Buffer.byteLength(data, 'utf8') / 1024)
        };
      }
    }
    
    return reply.send({ cached_tables: stats });
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

// ---------- ROUTE 10: Health Check ----------
fastify.get("/health", async (request, reply) => {
  try {
    const redisStatus = redis.isReady ? "connected" : "disconnected";
    return reply.send({
      status: "healthy",
      timestamp: new Date().toISOString(),
      redis: redisStatus,
      supabase: "connected"
    });
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

// ---------- GRACEFUL SHUTDOWN ----------
const gracefulShutdown = async (signal) => {
  console.log(`Received ${signal}, shutting down gracefully...`);
  try {
    await redis.quit();
    console.log("Redis connection closed");
    await fastify.close();
    console.log("Fastify server closed");
    process.exit(0);
  } catch (err) {
    console.error("Error during shutdown:", err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------- START SERVER ----------
const start = async () => {
  try {
    const PORT = process.env.PORT || 3000;
    const HOST = process.env.HOST || "0.0.0.0";
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`🚀 Fastify server running on ${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
