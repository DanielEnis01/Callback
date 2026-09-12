import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  getPdfDocument,
  initTigerData,
  storePdfDocument,
  tigerDb,
} from "../src/services/tigerdata.js";

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error("Usage: npm run test:pdf -- /absolute/path/to/your.pdf");
  }

  const pdfPath = path.resolve(input);
  const original = fs.readFileSync(pdfPath);
  await initTigerData();

  const saved = await storePdfDocument({
    documentId: crypto.randomUUID(),
    userId: "local-pdf-test-user",
    filename: path.basename(pdfPath),
    pdfBuffer: original,
  });
  const downloaded = await getPdfDocument({
    documentId: saved.document_id,
    userId: saved.user_id,
  });

  if (!downloaded || !downloaded.pdf_data.equals(original)) {
    throw new Error("Saved bytes did not match the original PDF.");
  }

  console.log("PDF round-trip passed:", {
    documentId: saved.document_id,
    filename: saved.filename,
    bytes: saved.file_size_bytes,
    sha256: saved.sha256,
  });
}

main()
  .catch((error) => {
    console.error("PDF test failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => tigerDb.end());
