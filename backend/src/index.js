import "dotenv/config";
import cors from "cors";
import express from "express";

import servicesRouter from "./routes/services.js";

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/services", servicesRouter);

app.listen(port, () => {
  console.log(`Callback backend listening on port ${port}`);
});
