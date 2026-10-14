import { MODULE_ID } from "./constants.mjs";
import { CompendiumIndex, normalize } from "./compendium.mjs";
import { addWithAdvancement } from "./advance.mjs";

const Trait = () => dnd5e.documents.Trait;

/** label/key (normalized) → trait key, for one trait type. */
async function traitLookup(trait) {
  const map = new Map();
  const choices = await Trait().choices(trait);
  choices.forEach((key, choice) => {
    if ( choice.selectable === false ) return;
    map.set(normalize(choice.label), key);
    map.set(normalize(key), key);
  });
  return map;
}

/** Match a free-text trait name to a key, allowing a few common spellings. */
function matchTrait(map, name, trait) {
  const n = normalize(name);
  const tries = [n, n.replace(/ (proficiency|proficiencies)$/, ""), n.replace(/s$/, ""),
    n.replace(/ armou?r$/, ""), n.replace(/ weapons?$/, ""), n.replace(/^all /, "")];
  if ( trait === "armor" ) tries.push(`${n} armor`);
  if ( trait === "weapon" ) tries.push(n.replace(/ weapons?$/, "").replace(/^(simple|martial)$/, "$1"),
    `${n.replace(/s$/, "")}`);
  for ( const t of tries ) if ( map.has(t) ) return map.get(t);
  return null;
}

/**
 * Apply proficiencies and other traits that the advancement flow did not already grant.
 * Anything that cannot be matched to a system key is kept in the trait's custom field.
 * @returns {string[]} notes about what could not be matched
 */
export async function applyTraits(actor, build) {
  const updates = {};
  const notes = [];

  const setMany = async (trait, names, { customPath, level=1 }={}) => {
    if ( !names?.length ) return;
    const map = await traitLookup(trait);
    const custom = [];
    for ( const name of names ) {
      const key = matchTrait(map, name, trait);
      if ( !key ) { custom.push(name); continue; }
      const keyPath = Trait().changeKeyPath(key, trait);
      const existing = updates[keyPath] ?? foundry.utils.getProperty(actor, keyPath);
      if ( ["Array", "Set"].includes(foundry.utils.getType(existing)) ) {
        const set = new Set(existing); set.add(key.split(":").pop());
        updates[keyPath] = Array.from(set);
      } else {
        updates[keyPath] = Math.max(Number(existing) || 0, level);
      }
      if ( trait === "tool" ) {
        const id = key.split(":").pop();
        const ability = CONFIG.DND5E.tools[id]?.ability;
        if ( ability && !foundry.utils.hasProperty(actor, `system.tools.${id}.ability`) ) {
          updates[`system.tools.${id}.ability`] = ability;
        }
      }
    }
    if ( custom.length ) {
      if ( customPath ) {
        const prior = String(foundry.utils.getProperty(actor, customPath) ?? "").split(";").map(s => s.trim()).filter(Boolean);
        updates[customPath] = [...new Set([...prior, ...custom])].join("; ");
      } else notes.push(`${trait}: could not match ${custom.join(", ")}`);
    }
  };

  await setMany("skills", build.skills);
  await setMany("skills", build.expertise, { level: 2 });
  await setMany("languages", build.languages, { customPath: "system.traits.languages.custom" });
  await setMany("tool", build.tools);
  await setMany("armor", build.armor, { customPath: "system.traits.armorProf.custom" });
  await setMany("weapon", build.weapons, { customPath: "system.traits.weaponProf.custom" });

  for ( const [sense, range] of Object.entries(build.senses ?? {}) ) {
    const current = foundry.utils.getProperty(actor, `system.attributes.senses.ranges.${sense}`) ?? 0;
    if ( range > current ) updates[`system.attributes.senses.ranges.${sense}`] = range;
  }

  for ( const [coin, amount] of Object.entries(build.currency ?? {}) ) {
    updates[`system.currency.${coin}`] = amount;
  }

  if ( build.finalScores ) {
    for ( const [abl, value] of Object.entries(build.abilities ?? {}) ) {
      if ( value ) updates[`system.abilities.${abl}.value`] = value;
    }
  }

  if ( !foundry.utils.isEmpty(updates) ) await actor.update(updates);
  return notes;
}

/**
 * Add feats (through advancement), equipment and spells.
 * Unresolved names become simple placeholder items when the setting allows it.
 * @returns {string[]} names that were not found in any compendium
 */
export async function applyItems(actor, build, rules) {
  const missing = [];
  const placeholders = game.settings.get(MODULE_ID, "placeholders");
  const owned = new Set(actor.items.map(i => normalize(i.name)));

  // Feats run their own advancements (ASIs, spell picks, etc.)
  for ( const feat of build.feats ?? [] ) {
    const name = typeof feat === "string" ? feat : feat.name;
    if ( owned.has(normalize(name)) ) continue;
    const entry = feat.uuid ? { uuid: feat.uuid } : await CompendiumIndex.find("feat", name, rules);
    if ( !entry ) { missing.push(`Feat: ${name}`); if ( placeholders ) await createPlaceholder(actor, "feat", name); continue; }
    const data = await CompendiumIndex.itemData(entry.uuid);
    if ( data ) await addWithAdvancement(actor, data);
  }

  // Equipment
  const physical = ["weapon", "equipment", "consumable", "tool", "loot", "container"];
  const toCreate = [];
  for ( const { name, quantity, uuid } of build.equipment ?? [] ) {
    if ( owned.has(normalize(name)) ) continue;
    const entry = uuid ? { uuid } : (await CompendiumIndex.find(physical, name, rules)
      ?? await CompendiumIndex.find(physical, name.replace(/e?s$/i, ""), rules));
    if ( !entry ) {
      missing.push(`Item: ${name}`);
      if ( placeholders ) toCreate.push({ name, type: "loot", system: { quantity } });
      continue;
    }
    const data = await CompendiumIndex.itemData(entry.uuid);
    if ( !data ) continue;
    if ( quantity > 1 ) data.system.quantity = quantity;
    toCreate.push(data);
  }

  // Spells
  for ( const s of build.spells ?? [] ) {
    const name = typeof s === "string" ? s : s.name;
    if ( owned.has(normalize(name)) ) continue;
    const entry = s.uuid ? { uuid: s.uuid } : await CompendiumIndex.find("spell", name, rules);
    if ( !entry ) {
      missing.push(`Spell: ${name}`);
      if ( placeholders ) toCreate.push({ name, type: "spell" });
      continue;
    }
    const data = await CompendiumIndex.itemData(entry.uuid);
    if ( data ) toCreate.push(data);
  }

  if ( toCreate.length ) await actor.createEmbeddedDocuments("Item", toCreate);
  return missing;
}

async function createPlaceholder(actor, type, name) {
  await actor.createEmbeddedDocuments("Item", [{ name, type, flags: { [MODULE_ID]: { placeholder: true } } }]);
}
