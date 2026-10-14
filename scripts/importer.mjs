import { MODULE_ID, ABILITIES } from "./constants.mjs";
import { CompendiumIndex } from "./compendium.mjs";
import { addWithAdvancement } from "./advance.mjs";
import { applyItems, applyTraits } from "./apply.mjs";

/**
 * Create a player character from a resolved build.
 *
 * Order follows the dnd5e advancement flow: species → background → class(es) → subclass,
 * then feats, gear, spells and leftover traits. Every advancement window the system needs
 * (HP, ASI/feat, skill picks, subclass, spells) opens in turn, exactly like dragging the
 * item onto the sheet, so 2014 and 2024 content each follow their own rules.
 *
 * @param {object} build
 * @returns {Promise<Actor5e|null>}
 */
export async function importCharacter(build) {
  const abilities = Object.fromEntries(ABILITIES.map(a => [a, { value: build.abilities?.[a] || 10 }]));
  const actor = await Actor.implementation.create({
    name: build.name || game.i18n.localize("PCIMP.DefaultName"),
    type: "character",
    img: build.img || undefined,
    system: { abilities },
    flags: { [MODULE_ID]: { importedAt: Date.now(), rules: build.rules } }
  });
  if ( !actor ) return null;

  const skipped = [];
  const step = async (label, uuid, overrides={}) => {
    if ( !uuid ) return;
    const data = await CompendiumIndex.itemData(uuid, overrides);
    if ( !data ) { skipped.push(label); return; }
    const ok = await addWithAdvancement(actor, data);
    if ( !ok ) skipped.push(`${label} (${data.name}) cancelled`);
  };

  await step("Species", build.speciesUuid);
  await step("Background", build.backgroundUuid);

  for ( const cls of build.classes ?? [] ) {
    if ( !cls.uuid ) continue;
    await step("Class", cls.uuid, { system: { levels: Math.clamp(cls.levels || 1, 1, 20) } });
    if ( cls.subclassUuid ) {
      const entry = await fromUuid(cls.subclassUuid);
      const already = actor.items.some(i => i.type === "subclass"
        && i.system.classIdentifier === entry?.system?.classIdentifier);
      if ( entry && !already ) await step("Subclass", cls.subclassUuid);
    }
  }

  const missing = await applyItems(actor, build, build.rules);
  const traitNotes = await applyTraits(actor, build);

  await actor.setFlag(MODULE_ID, "report", { skipped, missing, traitNotes });
  reportResult(actor, skipped, missing, traitNotes);
  actor.sheet.render({ force: true });
  return actor;
}

export function reportResult(actor, skipped=[], missing=[], notes=[]) {
  const problems = [...skipped, ...missing, ...notes];
  if ( !problems.length ) {
    ui.notifications.info(game.i18n.format("PCIMP.Done", { name: actor.name }));
    return;
  }
  ui.notifications.warn(game.i18n.format("PCIMP.DoneWithNotes", { name: actor.name, count: problems.length }));
  console.warn(`${MODULE_ID} | ${actor.name}:`, problems);
  const esc = foundry.utils.escapeHTML ?? (s => s);
  foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.format("PCIMP.ReportTitle", { name: actor.name }) },
    content: `<p>${game.i18n.localize("PCIMP.ReportIntro")}</p><ul class="pcimp-report">${
      problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul>`,
    ok: { label: game.i18n.localize("PCIMP.Close") }
  });
}
