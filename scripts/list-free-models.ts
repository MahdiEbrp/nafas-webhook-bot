/**
 * npm run models
 *
 * Prints every `:free` model OpenRouter currently offers, ranked the same way
 * the bot ranks them at runtime: curated quality prior, then measured speed,
 * then cooldowns. The top of this list is what the bot will actually try first.
 *
 * Free models come and go — run this whenever the bot starts failing, and edit
 * `QUALITY_TIERS` in lib/openrouter/ranking.ts if a good new one appears.
 */

import { getConfig } from "@/lib/config";
import { listFreeModels } from "@/lib/openrouter/models";
import { selectChain } from "@/lib/openrouter/select";

async function main(): Promise<void> {
  const config = getConfig();
  const models = await listFreeModels(true);
  const selection = await selectChain({ quiet: true });

  console.log(`\n${models.length} free models on OpenRouter (${new Date().toISOString()})`);
  console.log(`selection: ${config.modelSelection} · pool ${config.modelPoolSize} · min context ${config.modelMinContext}\n`);

  if (selection.note) console.log(`  ⚠ ${selection.note}\n`);

  console.log("  score  qual  speed    ctx   id");
  for (const model of selection.top) {
    const speed = model.latencyMs === null ? "  —    " : `${String(Math.round(model.latencyMs)).padStart(5)}ms`;
    console.log(
      [
        String(model.score).padStart(6),
        String(model.quality).padStart(5),
        speed,
        String(model.contextLength).padStart(7),
        ` ${model.id}`,
        model.samples > 0 ? ` (${model.samples} samples)` : "",
        model.coolingDown ? " ❄ cooling down" : "",
      ].join(""),
    );
  }

  console.log(`\n  considered ${selection.considered} of ${selection.catalogSize} models`);
  console.log(`\nchain the bot will walk (${selection.source}):`);
  selection.chain.forEach((id, index) => console.log(`  ${index + 1}. ${id}`));

  const ids = new Set(models.map((model) => model.id));
  const dead = config.modelChain.filter((id) => !ids.has(id));

  if (dead.length > 0) {
    console.log("\n⚠ these pinned models are gone from OpenRouter (they are only a fallback now):");
    for (const id of dead) console.log(`   ✗ ${id}`);
    console.log("\n  Suggested replacement:");
    console.log(`   OPENROUTER_MODELS=${selection.chain.join(",")}`);
  } else {
    console.log("\n✓ every pinned model still exists.");
  }
  console.log("");
}

main().catch((error) => {
  // This script talks to openrouter.ai, unlike the self-test which is offline.
  console.error("Failed to list models:", error instanceof Error ? error.message : error);
  console.error("(needs network access to openrouter.ai)");
  process.exitCode = 1;
});
