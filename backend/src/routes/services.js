import { Router } from "express";
import { checkTigerDataHealth } from "../services/tigerdata.js";

const router = Router();

// Placeholder status list for integrations
const SERVICES = ["gemini", "elevenlabs", "presage", "tigerdata", "backboard"];

router.get("/", async (_req, res) => {
  const tigerdataHealth = await checkTigerDataHealth();

  const serviceStatuses = SERVICES.map((name) => {
    if (name === "tigerdata") {
      return { name, status: tigerdataHealth.status, details: tigerdataHealth.message };
    }
    return { name, status: "not_implemented" };
  });

  res.json({ services: serviceStatuses });
});

// GET /api/services/tigerdata
// Returns connection and health status for TigerData
router.get("/tigerdata", async (_req, res) => {
  const health = await checkTigerDataHealth();
  const statusCode = health.status === "error" ? 500 : 200;
  res.status(statusCode).json(health);
});

export default router;
