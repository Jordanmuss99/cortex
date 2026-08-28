import { db, schema } from "../src/db/index.js";
import { eq } from "drizzle-orm";

async function run() {
  console.log("Starting em-dash scrub...");
  
  const artifacts = await db.select().from(schema.cognitiveArtifacts);
  let updatedCount = 0;

  for (const artifact of artifacts) {
    const originalContent = JSON.stringify(artifact.content);
    if (originalContent.includes("\u2014")) {
      console.log(`Found em-dash in artifact ${artifact.id}`);
      
      const newContentString = originalContent.replace(/\u2014/g, "--");
      const newContent = JSON.parse(newContentString);

      await db
        .update(schema.cognitiveArtifacts)
        .set({ content: newContent })
        .where(eq(schema.cognitiveArtifacts.id, artifact.id));
      
      updatedCount++;
    }
  }

  console.log(`Scrub complete. Updated ${updatedCount} artifacts.`);
  process.exit(0);
}

run().catch((err) => {
  console.error("Error running scrub:", err);
  process.exit(1);
});
