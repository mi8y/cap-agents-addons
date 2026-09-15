import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import cds from "@sap/cds";
import { vectorStore } from "./lib/vector-store.js";

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 200,
});

const streamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

export class IngestService extends cds.ApplicationService {
  init() {
    const { TextFiles } = this.entities;

    this.on("ingest", TextFiles, async (req) => {
      const fileId = req.params[0].ID;
      const file = await SELECT.one
        .from(TextFiles)
        .columns("ID", "content", "fileName")
        .where({ ID: fileId });

      if (!file) {
        return req.reject(404, "File not found");
      }

      if (!file?.content) {
        return req.reject(400, "Upload a text file before ingesting it");
      }

      const fileBuffer = await streamToBuffer(file.content);
      const chunks = await splitter.createDocuments([
        fileBuffer.toString("utf-8"),
      ]);

      const documents = chunks.map(
        (chunk, index) =>
          new Document({
            id: `${fileId}:${index}`,
            pageContent: chunk.pageContent,
            metadata: {
              sourceId: fileId,
              source: file.fileName,
              chunk: index,
            },
          }),
      );

      // ingest the documents into the vector store
      await vectorStore.addDocuments(documents);

      return { fileId: fileId, chunkCount: documents.length };
    });

    return super.init();
  }
}
