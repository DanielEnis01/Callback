import "dotenv/config";
import cors from "cors";
import express from "express";

import servicesRouter from "./routes/services.js";
import ttsRouter from "./routes/tts.js";
import sttRouter from "./routes/stt.js";

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/services", servicesRouter);
app.use("/api/tts", ttsRouter);
app.use("/api/stt", sttRouter);

app.listen(port, () => {
  console.log(`Callback backend listening on port ${port}`);
});
