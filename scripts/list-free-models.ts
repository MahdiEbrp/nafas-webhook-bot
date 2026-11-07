/**
 * npm run models
 *
 * Prints every :free model currently on OpenRouter, marks the ones that support
 * tool-calling / JSON mode, and shows whether your configured chain is still
 * alive. Free models come and go — run this whenever the bot starts failing.
 */

import { DEFAULT_MODEL_CHAIN, getConfig } from "@/lib/config";
import { listFreeModels } from "@/lib/openrouter/models";

async function main(): Promise<void> {
  const models = await listFreeModels(true);
  const configured = new Set(getConfig().modelChain);

  console.log(`\n${models.length} free models on OpenRouter (${new Date().toISOString()})\n`);
  console.log("  cfg  tools json  ctx       id");

  for (const model of models) {
    console.log(
      [
        configured.has(model.id) ? "  ✓  " : "     ",
        model.supportsTools ? "  ✓  " : "  ·  ",
        model.supportsJsonMode ? " ✓  " : " ·  ",
        String(model.contextLength).padStart(9),
        ` ${model.id}`,
      ].join(" ").replace(/\s+$/, ""),
    );
  }

  const ids = new Set(models.map((model) => model.id));
  const dead = getConfig().modelChain.filter((id) => !ids.has(id));

  console.log("\nconfigured chain:");
  for (const id of getConfig().modelChain) console.log(`  ${ids.has(id) ? "✓ alive" : "✗ gone "} ${id}`);

  if (dead.length > 0) {
    console.log(`\n⚠  ${dead.length} model(s) in OPENROUTER_MODELS no longer exist.`);
    console.log("   Suggested replacement order (tools + json first):");
    const suggestions = models.filter((model) => model.supportsTools && model.supportsJsonMode).slice(0, 5).map((m) => m.id);
    console.log(`   OPENROUTER_MODELS=${(suggestions.length > 0 ? suggestions : DEFAULT_MODEL_CHAIN).join(",")}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ every configured model is available.");
  }
}

main().catch((error) => {
  console.error("Failed to list models:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
