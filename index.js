const fastify = require("fastify")({ logger: true, bodyLimit: 10485760 });
const { createClient } = require("@supabase/supabase-js");
const { createClient: createRedisClient } = require("redis");
const nodeHtmlToImage = require("node-html-to-image");
require("dotenv").config();

// Supabase setup
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Redis setup
const redis = createRedisClient({ url: "redis://default:2LNEtD35z5Fzji5adNJifJccs4ClKG4LSKRNdQnQam1Nd6nj1hfuatteBiILfEKc@i4w8kc04g8ok8840k4w0w8ok:6379/0" });
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

// ---------- ROUTE 2: Prompt query with JSON structure output ----------
fastify.post("/prompt", async (request, reply) => {
  try {
    const { activity_id, current_slide } = request.body;
    if (!activity_id || typeof current_slide === "undefined")
      return reply.status(400).send({ error: "activity_id and current_slide are required" });

    const tableCacheKey = "public.prompt_table:ALL_DATA";
    let allData = null;
    const cachedAllData = await redis.get(tableCacheKey);

    if (cachedAllData) {
      allData = JSON.parse(cachedAllData);
    } else {
      const { data, error } = await supabase
        .schema("public")
        .from("prompt_table")
        .select("*");
      if (error) throw error;
      allData = data;
      await redis.setEx(tableCacheKey, 600, JSON.stringify(allData));
    }

    // Filter for activity_id
    const filteredRows = filterData(allData, { activity_id });

    // If no match, return empty array
    if (filteredRows.length === 0) {
      return reply.send([]);
    }

    // Return data in the required JSON format for each row
    const results = filteredRows.map(row => {
      let promptPicContent = "";
      if (Array.isArray(row.prompt_pic)) {
        promptPicContent = (row.prompt_pic && row.prompt_pic[current_slide]) || "";
      } else if (typeof row.prompt_pic === "object" && row.prompt_pic !== null) {
        promptPicContent = row.prompt_pic[current_slide] || "";
      } else {
        promptPicContent = row.prompt_pic ? String(row.prompt_pic) : "";
      }

      // Your example used the full_prompt as a long instruction plus embedded JSON (likely from pre_prompt)
      // To return your full raw SQL format, we use row.pre_prompt as the core, and replace variables as needed
      // If your pre_prompt contains literal JSON string (as in your example), just return as-is
      return {
        full_prompt: `${row.pre_prompt || ""} ${promptPicContent} ${row.post_prompt || ""}`.trim(),
        model_number: row.model_number
      };
    });

    return reply.send(results);
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

// ---------- REMAINING CACHE/QUERY/CRUD ROUTES (optional, include as you need the rest) ----------

fastify.post("/query", async (request, reply) => {
  try {
    const { table, schema = "prompt_info", filters = {}, columns = "*" } = request.body;
    if (!table) return reply.status(400).send({ error: "Table name is required" });

    const tableCacheKey = `${schema}.${table}:ALL_DATA`;
    const cachedAllData = await redis.get(tableCacheKey);
    if (cachedAllData) {
      const allData = JSON.parse(cachedAllData);
      const filteredData = filterData(allData, filters);
      return reply.send({ data: filteredData });
    }

    let query;
    if (schema && schema !== "public") {
      query = supabase.schema(schema).from(table).select(columns);
    } else {
      query = supabase.from(table).select(columns);
    }
    const { data: allData, error } = await query;
    if (error) throw error;
    await redis.setEx(tableCacheKey, 600, JSON.stringify(allData));
    const filteredData = filterData(allData, filters);
    return reply.send({ data: filteredData });
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
