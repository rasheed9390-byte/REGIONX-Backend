const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const https = require("https");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ==========================================
// POSTGRESQL
// ==========================================

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ==========================================
// DATABASE SETUP
// ==========================================

async function ensureDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS latency_tests (
        id BIGSERIAL PRIMARY KEY,
        tested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        location TEXT NOT NULL DEFAULT 'India • Telangana',
        best_region TEXT,
        best_latency INTEGER,
        region_count INTEGER NOT NULL DEFAULT 0,
        results JSONB NOT NULL
      );
    `);

    console.log("PostgreSQL schema ready");
  } catch (error) {
    console.error("Database schema error:");
    console.error(error.message);
  }
}

// ==========================================
// SAVE HISTORY
// ==========================================

async function saveLatencyTest(results, bestRegion) {
  try {
    const result = await pool.query(
      `
      INSERT INTO latency_tests
      (
        location,
        best_region,
        best_latency,
        region_count,
        results
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, tested_at
      `,
      [
        "India • Telangana",
        bestRegion ? bestRegion.name : null,
        bestRegion ? bestRegion.latency : null,
        results.length,
        JSON.stringify(results),
      ]
    );

    return result.rows[0];
  } catch (error) {
    console.error("Could not save latency history:");
    console.error(error.message);

    return null;
  }
}

// ==========================================
// HOME
// ==========================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "REGIONX backend is running",
    database: "PostgreSQL",
  });
});

// ==========================================
// DATABASE TEST
// ==========================================

app.get("/api/db-test", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT NOW() AS current_time"
    );

    res.json({
      success: true,
      message: "Database connection is working",
      time: result.rows[0].current_time,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Database connection failed",
      error: error.message,
    });
  }
});

// ==========================================
// AWS REGIONS
// ==========================================

const AWS_REGIONS = [
  {
    region: "ap-south-1",
    name: "Mumbai",
    url: "https://s3.ap-south-1.amazonaws.com/",
  },
  {
    region: "ap-southeast-1",
    name: "Singapore",
    url: "https://s3.ap-southeast-1.amazonaws.com/",
  },
  {
    region: "eu-central-1",
    name: "Frankfurt",
    url: "https://s3.eu-central-1.amazonaws.com/",
  },
  {
    region: "us-east-1",
    name: "US East",
    url: "https://s3.us-east-1.amazonaws.com/",
  },
];

// ==========================================
// LATENCY STATUS
// ==========================================

function getLatencyStatus(latency) {
  if (latency < 50) return "EXCELLENT";
  if (latency < 100) return "GOOD";
  if (latency <= 150) return "AVERAGE";
  return "HIGH";
}

// ==========================================
// MEASURE ONE REGION
// ==========================================

function measureLatency(region) {
  return new Promise((resolve) => {
    const start = Date.now();

    const request = https.get(
      region.url,
      {
        timeout: 2500,
        headers: {
          "User-Agent": "REGIONX-Latency-Test",
          "Cache-Control": "no-cache",
        },
      },
      (response) => {
        const latency = Date.now() - start;

        response.resume();

        resolve({
          region: region.region,
          name: region.name,
          latency,
          status: getLatencyStatus(latency),
          reachable: true,
          http_status: response.statusCode,
        });
      }
    );

    request.on("timeout", () => {
      request.destroy();

      resolve({
        region: region.region,
        name: region.name,
        latency: 2500,
        status: "HIGH",
        reachable: false,
        error: "Request timed out",
      });
    });

    request.on("error", (error) => {
      resolve({
        region: region.region,
        name: region.name,
        latency: Date.now() - start,
        status: "HIGH",
        reachable: false,
        error: error.message,
      });
    });
  });
}

// ==========================================
// LATENCY API
// ==========================================

app.get("/api/latency", async (req, res) => {
  try {
    console.log("Starting AWS latency test...");

    // Get regions selected by the user
    const requestedRegions =
      typeof req.query.regions === "string"
        ? req.query.regions
            .split(",")
            .map((region) => region.trim())
            .filter(Boolean)
        : AWS_REGIONS.map((region) => region.region);

    // Only test selected regions
    const regionsToTest = AWS_REGIONS.filter((region) =>
      requestedRegions.includes(region.region)
    );

    if (regionsToTest.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid regions selected",
      });
    }

    console.log(
      "Regions selected:",
      regionsToTest.map((region) => region.name)
    );

    const results = await Promise.all(
      regionsToTest.map((region) =>
        measureLatency(region)
      )
    );

    const reachableResults = results.filter(
      (result) => result.reachable
    );

    let bestRegion = null;

    if (reachableResults.length > 0) {
      bestRegion = reachableResults.reduce(
        (best, current) => {
          return current.latency < best.latency
            ? current
            : best;
        }
      );
    }

    console.log("Latency results:");
    console.log(results);

    // SAVE RESULT TO POSTGRESQL
    const history = await saveLatencyTest(
      results,
      bestRegion
    );

    res.json({
      success: true,
      results,
      best_region: bestRegion,
      history_id: history ? history.id : null,
      tested_at: history ? history.tested_at : null,
    });

  } catch (error) {
    console.error("Latency test failed:");
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Latency test failed",
      error: error.message,
    });
  }
});

// ==========================================
// HISTORY API
// ==========================================

app.get("/api/history", async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(
        parseInt(req.query.limit) || 20,
        1
      ),
      100
    );

    const result = await pool.query(
      `
      SELECT
        id,
        tested_at,
        location,
        best_region,
        best_latency,
        region_count
      FROM latency_tests
      ORDER BY tested_at DESC
      LIMIT $1
      `,
      [limit]
    );

    res.json({
      success: true,
      history: result.rows,
    });

  } catch (error) {
    console.error("History fetch failed:");
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Could not fetch history",
      error: error.message,
    });
  }
});

// ==========================================
// HEALTH
// ==========================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "REGIONX API is healthy",
  });
});

// ==========================================
// START SERVER
// ==========================================

async function startServer() {
  await ensureDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `REGIONX backend running on port ${PORT}`
    );
  });
}

startServer();