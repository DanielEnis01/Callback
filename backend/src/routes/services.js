import { Router } from "express";

const router = Router();

// Placeholder status endpoints — one per integration, wired up as each
// service module gets implemented.
const SERVICES = ["gemini", "elevenlabs", "presage", "tigerdata", "backboard"];

router.get("/", (_req, res) => {
  res.json({ services: SERVICES.map((name) => ({ name, status: "not_implemented" })) });
});

export default router;
