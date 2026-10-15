import { MODULE_ID } from "./constants.mjs";
import { CompendiumIndex, detectRules } from "./compendium.mjs";
import { addWithAdvancement, changeClassLevel } from "./advance.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Level an existing class or multiclass into a new one. The dnd5e advancement manager
 * handles HP, ASI/feat choices, subclass picks and new features for the rules version
 * the class item was written for.
 */
export class LevelUpApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options={}) {
    super({ ...options, id: `pc-5e-importer-levelup-${actor.id}` });
    this.actor = actor;
    const first = actor.items.find(i => i.type === "class" && i.id === actor.system.details.originalClass)
      ?? actor.items.find(i => i.type === "class");
    this.pc = { mode: first ? "existing" : "new", classId: first?.id ?? "", newClassUuid: "", levels: 1 };
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["pcimp", "pcimp-levelup"],
    window: { title: "PCIMP.LevelUpTitle", icon: "fa-solid fa-angles-up" },
    position: { width: 480, height: "auto" },
    form: { handler: LevelUpApp.#onChange, submitOnChange: true, closeOnSubmit: false },
    actions: { levelUp: LevelUpApp.#onLevelUp }
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/level-up.hbs` } };

  get title() { return game.i18n.format("PCIMP.LevelUpFor", { name: this.actor.name }); }

  async _prepareContext() {
    const actor = this.actor;
    const s = this.pc;
    const owned = actor.items.filter(i => i.type === "class");
    const ownedIds = new Set(owned.map(c => c.identifier ?? c.system.identifier));
    const rules = detectRules(owned.map(c => ({ rules: c.system.source?.rules }))).rules;
    const newOptions = (await CompendiumIndex.list("class", rules)).filter(e => !ownedIds.has(e.identifier));

    const current = actor.system.details.level ?? 0;
    const target = Math.min(current + (Number(s.levels) || 1), 20);
    const conMod = actor.system.abilities.con?.mod ?? 0;

    let hd = "", warnings = [], className = "", classFrom = 0;
    if ( s.mode === "existing" ) {
      const cls = actor.items.get(s.classId);
      hd = cls?.system.hd?.denomination ?? "";
      className = cls?.name ?? "";
      classFrom = cls?.system.levels ?? 0;
      if ( cls && cls.system.levels + Number(s.levels) > 20 ) warnings.push(game.i18n.localize("PCIMP.ClassMax"));
    } else if ( s.newClassUuid ) {
      const doc = await fromUuid(s.newClassUuid);
      hd = doc?.system.hd?.denomination ?? "";
      className = doc?.name ?? "";
      warnings.push(...multiclassWarnings(actor, [...owned, doc].filter(Boolean)));
    }
    if ( current >= 20 ) warnings.push(game.i18n.localize("PCIMP.MaxLevel"));
    const die = Number(hd.replace("d", "")) || 0;
    const avg = die ? (die / 2 + 1 + conMod) * (Number(s.levels) || 1) : null;

    return {
      actor, state: s, className,
      existing: s.mode === "existing", isNew: s.mode === "new",
      hasClasses: owned.length > 0,
      classOptions: owned.map(c => ({ value: c.id, label: `${c.name} ${c.system.levels}`
        + (c.subclass ? ` (${c.subclass.name})` : ""), selected: c.id === s.classId })),
      newOptions: newOptions.map(e => ({ value: e.uuid, label: e.rules ? `${e.name} (${e.rules})` : e.name,
        selected: e.uuid === s.newClassUuid })),
      preview: {
        from: current, to: target,
        profFrom: prof(current), profTo: prof(target),
        hd, avg, asiLevel: [4, 8, 12, 16, 19].some(l => l > classFrom && l <= classFrom + (Number(s.levels) || 1))
      },
      warnings,
      canLevel: current < 20 && (s.mode === "existing" ? !!s.classId : !!s.newClassUuid)
    };
  }

  static #onChange(event, form, formData) {
    const d = formData.object;
    Object.assign(this.pc, {
      mode: d.mode ?? this.pc.mode,
      classId: d.classId ?? this.pc.classId,
      newClassUuid: d.newClassUuid ?? this.pc.newClassUuid,
      levels: Math.clamp(Number(d.levels) || 1, 1, 19)
    });
    this.render();
  }

  static async #onLevelUp(event, target) {
    const s = this.pc;
    const actor = this.actor;
    const room = 20 - (actor.system.details.level ?? 0);
    const levels = Math.min(Number(s.levels) || 1, room);
    if ( levels < 1 ) return ui.notifications.warn(game.i18n.localize("PCIMP.MaxLevel"));
    target.disabled = true;
    await this.close();

    let ok;
    if ( s.mode === "existing" ) {
      const cls = actor.items.get(s.classId);
      if ( !cls ) return;
      ok = await changeClassLevel(actor, cls, Math.min(levels, 20 - cls.system.levels));
    } else {
      const data = await CompendiumIndex.itemData(s.newClassUuid, { system: { levels } });
      if ( !data ) return ui.notifications.error(game.i18n.localize("PCIMP.Failed"));
      ok = await addWithAdvancement(actor, data);
    }
    if ( ok ) ui.notifications.info(game.i18n.format("PCIMP.LeveledUp", {
      name: actor.name, level: actor.system.details.level
    }));
  }
}

function prof(level) { return `+${Math.ceil(Math.max(level, 1) / 4) + 1}`; }

/** Multiclass ability prerequisites (13 in the primary ability) for every class involved. */
function multiclassWarnings(actor, classes) {
  const out = [];
  for ( const cls of classes ) {
    const req = Array.from(cls.system.primaryAbility?.value ?? []);
    if ( !req.length ) continue;
    const meets = s => (actor.system.abilities[s]?.value ?? 0) >= 13;
    const ok = cls.system.primaryAbility.all ? req.every(meets) : req.some(meets);
    if ( !ok ) out.push(game.i18n.format("PCIMP.MulticlassReq", {
      class: cls.name,
      abilities: req.map(a => CONFIG.DND5E.abilities[a]?.label ?? a).join(cls.system.primaryAbility.all ? " & " : " / ")
    }));
  }
  return out;
}
