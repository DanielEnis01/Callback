import "dotenv/config";
import cors from "cors";
import express from "express";

import servicesRouter from "./routes/services.js";
import sessionsRouter from "./routes/sessions.js";
import { initTigerData } from "./services/tigerdata.js";

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/services", servicesRouter);
app.use("/api/sessions", sessionsRouter);

app.listen(port, async () => {
  console.log(`Callback backend listening on port ${port}`);
  await initTigerData();
});
