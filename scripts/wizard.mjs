import { MODULE_ID, ABILITIES, STANDARD_ARRAY, POINT_BUY_COST, POINT_BUY_BUDGET } from "./constants.mjs";
import { CompendiumIndex, detectRules, defaultRules } from "./compendium.mjs";
import { parseCharacter, parseQuantity } from "./parser.mjs";
import { importCharacter } from "./importer.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TABS = ["paste", "species", "background", "class", "abilities", "extras", "review"];
const TAB_ICONS = {
  paste: "fa-paste", species: "fa-dragon", background: "fa-scroll", class: "fa-shield-halved",
  abilities: "fa-dice-d20", extras: "fa-sack", review: "fa-clipboard-check"
};
const LIST_FIELDS = ["skills", "expertise", "languages", "tools", "armor", "weapons", "feats", "equipment", "spells"];
const PHYSICAL = ["weapon", "equipment", "consumable", "tool", "loot", "container"];

/** Chip pickers on the Items & Traits tab: field → where the suggestions come from. */
const CHIP_FIELDS = [
  { field: "feats", label: "PCIMP.Feats", source: { types: ["feat"], featOnly: true } },
  { field: "spells", label: "PCIMP.Spells", source: { types: ["spell"] } },
  { field: "equipment", label: "PCIMP.Equipment", source: { types: PHYSICAL } },
  { field: "languages", label: "PCIMP.Languages", trait: "languages" },
  { field: "tools", label: "PCIMP.Tools", trait: "tool" },
  { field: "armor", label: "PCIMP.Armor", trait: "armor" },
  { field: "weapons", label: "PCIMP.Weapons", trait: "weapon" }
];

const blankClass = () => ({ uuid: "", subclassUuid: "", levels: 1 });
const splitList = v => String(v ?? "").split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
const joinList = a => a.join(", ");

/**
 * PC importer: paste a sheet and/or pick everything by clicking cards, then hand it to the
 * dnd5e advancement flow. (Instance data lives on `this.pc` — ApplicationV2 reserves `state`.)
 */
export class PCImporterWizard extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options={}) {
    super(options);
    this.pc = PCImporterWizard.blankState(options.initialName);
    this.classInfo = {};
    this.descriptions = new Map();
    this.traitLabels = {};
  }

  static blankState(name="") {
    return {
      tab: "paste", paste: "", name, img: "", rules: "any",
      speciesUuid: "", backgroundUuid: "",
      classes: [blankClass()], activeClass: 0,
      method: "standard",
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
      finalScores: false,
      ...Object.fromEntries(LIST_FIELDS.map(f => [f, ""])),
      senses: "", currency: "",
      parseWarnings: []
    };
  }

  static DEFAULT_OPTIONS = {
    id: "pc-5e-importer-wizard",
    tag: "form",
    classes: ["pcimp", "pcimp-wizard"],
    window: { title: "PCIMP.WizardTitle", icon: "fa-solid fa-user-plus", resizable: true },
    position: { width: 900, height: 760 },
    form: { handler: PCImporterWizard.#onChange, submitOnChange: true, closeOnSubmit: false },
    actions: {
      tab: PCImporterWizard.#onTab,
      parse: PCImporterWizard.#onParse,
      next: PCImporterWizard.#onNext,
      prev: PCImporterWizard.#onPrev,
      setRules: PCImporterWizard.#onSetRules,
      pick: PCImporterWizard.#onPick,
      setActiveClass: PCImporterWizard.#onSetActiveClass,
      addClass: PCImporterWizard.#onAddClass,
      removeClass: PCImporterWizard.#onRemoveClass,
      levelStep: PCImporterWizard.#onLevelStep,
      abilityStep: PCImporterWizard.#onAbilityStep,
      setMethod: PCImporterWizard.#onSetMethod,
      cycleSkill: PCImporterWizard.#onCycleSkill,
      addChip: PCImporterWizard.#onAddChip,
      removeChip: PCImporterWizard.#onRemoveChip,
      reset: PCImporterWizard.#onReset,
      reloadLists: PCImporterWizard.#onReloadLists,
      create: PCImporterWizard.#onCreate
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/wizard.hbs`, scrollable: [".pcimp-cards", ".pcimp-detail", ".pcimp-body"] }
  };

  /* ------------------------------------------------------------ */
  /*  Context                                                     */
  /* ------------------------------------------------------------ */

  #tabs(byUuid) {
    const s = this.pc;
    const picked = {
      species: byUuid?.get(s.speciesUuid)?.name,
      background: byUuid?.get(s.backgroundUuid)?.name,
      class: s.classes.filter(c => c.uuid).map(c => `${byUuid?.get(c.uuid)?.name ?? "?"} ${c.levels}`).join(" / ")
    };
    return TABS.map((id, i) => ({
      id, number: i + 1, label: `PCIMP.Tab.${id}`, icon: TAB_ICONS[id],
      active: s.tab === id, picked: picked[id] || "", done: !!picked[id]
    }));
  }

  async _prepareContext() {
    const s = this.pc;
    const header = {
      state: s,
      rulesButtons: ["any", "2014", "2024"].map(r => ({ value: r, label: `PCIMP.Rules.${r}`, active: s.rules === r }))
    };
    if ( !CompendiumIndex.ready ) {
      // Open the window straight away; fill it in once the lists are read.
      CompendiumIndex.load()
        .then(() => this.rendered && this.render())
        .catch(err => {
          console.error(`${MODULE_ID} |`, err);
          ui.notifications.error(`PC Importer: ${err?.message ?? err}`);
        });
      return { ...header, loading: true, tabs: this.#tabs(), isFirstTab: true, isLastTab: false };
    }

    const rules = s.rules;
    const [species, backgrounds, classes, subclasses] = await Promise.all(
      ["race", "background", "class", "subclass"].map(t => CompendiumIndex.list(t, rules)));
    // Look-ups use every rules version, so a pick survives switching the filter.
    const all = await Promise.all(["race", "background", "class", "subclass"].map(t => CompendiumIndex.list(t, "any")));
    const byUuid = new Map(all.flat().map(e => [e.uuid, e]));

    for ( const c of s.classes ) if ( c.uuid ) await this.#classInfo(c.uuid);
    const totalLevel = s.classes.reduce((t, c) => t + (Number(c.levels) || 0), 0);
    const firstInfo = this.classInfo[s.classes[0]?.uuid];
    const conMod = Math.floor(((Number(s.abilities.con) || 10) - 10) / 2);

    const context = {
      ...header,
      tabs: this.#tabs(byUuid),
      tab: Object.fromEntries(TABS.map(t => [t, s.tab === t])),
      isFirstTab: s.tab === TABS[0], isLastTab: s.tab === TABS.at(-1),
      preview: {
        level: totalLevel,
        prof: signed(Math.ceil(Math.max(totalLevel, 1) / 4) + 1),
        hp1: firstInfo?.hdMax ? firstInfo.hdMax + conMod : null
      },
      found: {
        none: !classes.length && !species.length && !backgrounds.length,
        stats: CompendiumIndex.stats, failed: CompendiumIndex.stats?.failed ?? []
      }
    };

    if ( s.tab === "species" ) context.picker = await this.#picker("species", species, s.speciesUuid);
    if ( s.tab === "background" ) context.picker = await this.#picker("background", backgrounds, s.backgroundUuid);
    if ( s.tab === "class" ) Object.assign(context, await this.#classPage(classes, subclasses, byUuid));
    if ( s.tab === "abilities" ) Object.assign(context, this.#abilityPage());
    if ( s.tab === "extras" ) Object.assign(context, await this.#extrasPage());
    if ( s.tab === "review" ) context.review = await this.#review(byUuid);
    return context;
  }

  /** Card grid + details for one kind of pick. */
  async #picker(kind, list, selected, { field=kind, extra={} }={}) {
    const cards = list.map(e => ({
      uuid: e.uuid, name: e.name, img: e.img || "icons/svg/item-bag.svg", rules: e.rules, pack: e.pack,
      selected: e.uuid === selected, search: `${e.name} ${e.rules} ${e.pack}`.toLowerCase()
    }));
    const chosen = list.find(e => e.uuid === selected)
      ?? (await CompendiumIndex.list({ species: "race", subclass: "subclass" }[kind] ?? kind, "any")).find(e => e.uuid === selected);
    return {
      kind, field, cards, count: cards.length,
      title: `PCIMP.Pick.${kind}`,
      chosen: chosen ? { name: chosen.name, img: chosen.img, rules: chosen.rules, pack: chosen.pack,
        description: await this.#description(chosen.uuid), ...extra } : null
    };
  }

  async #classPage(classes, subclasses, byUuid) {
    const s = this.pc;
    s.activeClass = Math.clamp(s.activeClass ?? 0, 0, s.classes.length - 1);
    const row = s.classes[s.activeClass];
    const cls = byUuid.get(row.uuid);
    const info = row.uuid ? this.classInfo[row.uuid] : null;
    // Classes already used in another slot can't be picked twice.
    const taken = new Set(s.classes.filter((c, i) => i !== s.activeClass).map(c => c.uuid));
    const picker = await this.#picker("class", classes.filter(e => !taken.has(e.uuid)), row.uuid, {
      extra: info ? { facts: [
        { label: "PCIMP.HitDie", value: info.hd },
        { label: "PCIMP.Primary", value: info.primaryLabel },
        info.subclassLevel ? { label: "PCIMP.SubclassAt", value: info.subclassLevel } : null
      ].filter(f => f?.value) } : {}
    });

    let subclass = null;
    if ( cls ) {
      // Only subclasses written for this class's rules version (2014 class → 2014 subclasses).
      const subs = (await CompendiumIndex.list("subclass", "any")).filter(e => e.classIdentifier === cls.identifier
        && (!cls.rules || !e.rules || e.rules === cls.rules));
      const locked = info?.subclassLevel && (Number(row.levels) < info.subclassLevel);
      subclass = await this.#picker("subclass", subs, row.subclassUuid, { field: "subclass" });
      subclass.locked = locked;
      subclass.unlockLevel = info?.subclassLevel;
      subclass.later = !row.subclassUuid;
    }
    return {
      picker,
      subclass,
      classSlots: s.classes.map((c, i) => ({
        index: i, active: i === s.activeClass, removable: i > 0,
        label: c.uuid ? `${byUuid.get(c.uuid)?.name ?? "?"} ${c.levels}` : game.i18n.localize("PCIMP.PickClass")
      })),
      activeLevel: row.levels, canDown: row.levels > 1, canUp: row.levels < 20
    };
  }

  #abilityPage() {
    const s = this.pc;
    const primary = new Set(s.classes.flatMap(c => this.classInfo[c.uuid]?.primary ?? []));
    const used = ABILITIES.map(a => Number(s.abilities[a]) || 0);
    const pointsSpent = used.reduce((t, v) => t + (POINT_BUY_COST[v] ?? 99), 0);
    const abilities = ABILITIES.map(key => {
      const value = Number(s.abilities[key]) || 0;
      const [min, max] = s.method === "pointbuy" ? [8, 15] : [1, 30];
      const nextCost = (POINT_BUY_COST[value + 1] ?? 99) - (POINT_BUY_COST[value] ?? 0);
      return {
        key, value, label: CONFIG.DND5E.abilities[key]?.label ?? key.toUpperCase(),
        mod: signed(Math.floor((value - 10) / 2)), primary: primary.has(key),
        options: STANDARD_ARRAY.map(v => ({ value: v, selected: v === value })),
        canDown: value > min,
        canUp: value < max && (s.method !== "pointbuy" || pointsSpent + nextCost <= POINT_BUY_BUDGET)
      };
    });
    return {
      abilities,
      methodButtons: ["standard", "pointbuy", "manual"].map(m => ({ value: m, label: `PCIMP.Method.${m}`, active: m === s.method })),
      method: { standard: s.method === "standard", pointbuy: s.method === "pointbuy", manual: s.method === "manual" },
      pointsLeft: POINT_BUY_BUDGET - pointsSpent, pointsOver: pointsSpent > POINT_BUY_BUDGET,
      pointBuyBudget: POINT_BUY_BUDGET
    };
  }

  async #extrasPage() {
    const s = this.pc;
    const rules = s.rules;
    const chips = [];
    for ( const def of CHIP_FIELDS ) {
      let options;
      if ( def.trait ) options = await this.#traitOptions(def.trait);
      else {
        let pool = (await Promise.all(def.source.types.map(t => CompendiumIndex.list(t, rules)))).flat();
        if ( def.source.featOnly ) pool = pool.filter(e => !e.featType || e.featType === "feat");
        options = [...new Set(pool.map(e => e.name))].sort((a, b) => a.localeCompare(b));
      }
      chips.push({
        field: def.field, label: def.label, listId: `pcimp-dl-${def.field}`, options,
        values: splitList(s[def.field]).map((v, i) => ({ value: v, index: i }))
      });
    }
    const prof = new Set(splitList(s.skills).map(v => v.toLowerCase()));
    const expert = new Set(splitList(s.expertise).map(v => v.toLowerCase()));
    const skills = Object.entries(CONFIG.DND5E.skills ?? {}).map(([key, cfg]) => {
      const label = cfg.label ?? key;
      const l = label.toLowerCase();
      const level = expert.has(l) ? 2 : prof.has(l) ? 1 : 0;
      return { key, label, level, prof: level === 1, expert: level === 2 };
    }).sort((a, b) => a.label.localeCompare(b.label));
    return { chips, skills };
  }

  async #traitOptions(trait) {
    if ( this.traitLabels[trait] ) return this.traitLabels[trait];
    const out = [];
    try {
      const choices = await dnd5e.documents.Trait.choices(trait);
      choices.forEach((key, choice) => { if ( choice.selectable !== false && choice.label ) out.push(choice.label); });
    } catch(err) { console.warn(`${MODULE_ID} | No ${trait} list`, err); }
    return this.traitLabels[trait] = [...new Set(out)].sort((a, b) => a.localeCompare(b));
  }

  async #description(uuid) {
    if ( !uuid ) return "";
    if ( this.descriptions.has(uuid) ) return this.descriptions.get(uuid);
    let html = "";
    try {
      const doc = await fromUuid(uuid);
      const raw = doc?.system?.description?.value ?? "";
      const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
      html = raw && TE?.enrichHTML ? await TE.enrichHTML(raw, { relativeTo: doc, secrets: false }) : raw;
    } catch(err) { console.warn(`${MODULE_ID} | Description failed for ${uuid}`, err); }
    this.descriptions.set(uuid, html);
    return html;
  }

  async #classInfo(uuid) {
    if ( this.classInfo[uuid] ) return this.classInfo[uuid];
    const doc = await fromUuid(uuid);
    const primary = Array.from(doc?.system?.primaryAbility?.value ?? []);
    const hd = doc?.system?.hd?.denomination ?? "";
    let subclassLevel = null;
    try {
      const adv = doc?.toObject?.().system?.advancement ?? {};
      const list = Array.isArray(adv) ? adv : Object.values(adv);
      subclassLevel = list.find(a => a.type === "Subclass")?.level ?? null;
    } catch { /* older data */ }
    return this.classInfo[uuid] = {
      primary, hd, hdMax: Number(hd.replace("d", "")) || 0, subclassLevel,
      primaryLabel: primary.map(a => CONFIG.DND5E.abilities[a]?.label ?? a).join(" / ")
    };
  }

  /** Resolve everything the way the importer will, so the user can see what will and won't land. */
  async #review(byUuid) {
    const s = this.pc;
    const picked = [byUuid.get(s.speciesUuid), byUuid.get(s.backgroundUuid),
      ...s.classes.flatMap(c => [byUuid.get(c.uuid), byUuid.get(c.subclassUuid)])];
    const { rules, mixed } = s.rules === "any" ? detectRules(picked) : { rules: s.rules, mixed: false };

    const resolve = async (types, names) => Promise.all(names.map(async n => {
      const name = typeof n === "string" ? n : n.name;
      const hit = await CompendiumIndex.find(types, name, rules)
        ?? (Array.isArray(types) ? await CompendiumIndex.find(types, name.replace(/e?s$/i, ""), rules) : null);
      return { name, qty: n.quantity > 1 ? n.quantity : null, found: !!hit, match: hit?.name, rules: hit?.rules,
        pack: hit?.pack };
    }));

    const build = this.toBuild(rules);
    const core = [
      { label: "PCIMP.Species", entry: byUuid.get(s.speciesUuid), tab: "species" },
      { label: "PCIMP.Background", entry: byUuid.get(s.backgroundUuid), tab: "background" },
      ...s.classes.map(c => ({ label: "PCIMP.Class", entry: byUuid.get(c.uuid), levels: c.levels, tab: "class" })),
      ...build.classes.filter(c => c.subclassUuid).map(c => ({ label: "PCIMP.Subclass", entry: byUuid.get(c.subclassUuid), tab: "class" }))
    ];
    return {
      rules, mixed,
      core: core.map(c => ({ ...c, name: c.entry?.name, img: c.entry?.img, entryRules: c.entry?.rules, missing: !c.entry })),
      lists: [
        { title: "PCIMP.Feats", rows: await resolve("feat", build.feats) },
        { title: "PCIMP.Equipment", rows: await resolve(PHYSICAL, build.equipment) },
        { title: "PCIMP.Spells", rows: await resolve("spell", build.spells) }
      ],
      placeholderNote: game.settings.get(MODULE_ID, "placeholders") ? "PCIMP.WillPlaceholder" : "PCIMP.WillSkip",
      traits: [
        ["PCIMP.Skills", build.skills], ["PCIMP.Expertise", build.expertise],
        ["PCIMP.Languages", build.languages], ["PCIMP.Tools", build.tools],
        ["PCIMP.Armor", build.armor], ["PCIMP.Weapons", build.weapons],
        ["PCIMP.Senses", Object.entries(build.senses).map(([k, v]) => `${k} ${v}`)],
        ["PCIMP.Currency", Object.entries(build.currency).map(([k, v]) => `${v} ${k}`)]
      ].filter(([, v]) => v.length).map(([label, v]) => ({ label, value: v.join(", ") })),
      canCreate: !!s.classes[0]?.uuid
    };
  }

  /** Turn wizard data into the importer's build object. */
  toBuild(rules) {
    const s = this.pc;
    const list = f => splitList(s[f]);
    const senses = {};
    for ( const part of list("senses") ) {
      const m = part.match(/([a-z]+)\s*(\d+)/i);
      if ( m ) senses[m[1].toLowerCase()] = Number(m[2]);
    }
    const currency = {};
    for ( const m of String(s.currency).matchAll(/(\d[\d,]*)\s*(pp|gp|ep|sp|cp)\b/gi) ) {
      currency[m[2].toLowerCase()] = Number(m[1].replace(/,/g, ""));
    }
    return {
      name: s.name, img: s.img, rules,
      abilities: Object.fromEntries(ABILITIES.map(a => [a, Number(s.abilities[a]) || 10])),
      finalScores: s.finalScores,
      speciesUuid: s.speciesUuid, backgroundUuid: s.backgroundUuid,
      classes: s.classes.filter(c => c.uuid).map(c => {
        const levels = Number(c.levels) || 1;
        // A subclass picked before its unlock level waits for the level-up that grants it.
        const unlock = this.classInfo[c.uuid]?.subclassLevel;
        return { ...c, levels, subclassUuid: unlock && levels < unlock ? "" : c.subclassUuid };
      }),
      skills: list("skills"), expertise: list("expertise"), languages: list("languages"),
      tools: list("tools"), armor: list("armor"), weapons: list("weapons"),
      feats: list("feats"), equipment: list("equipment").map(parseQuantity), spells: list("spells"),
      senses, currency
    };
  }

  /* ------------------------------------------------------------ */
  /*  Rendering hooks                                             */
  /* ------------------------------------------------------------ */

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if ( !root ) return;

    // Live search over the cards, without re-rendering.
    for ( const input of root.querySelectorAll(".pcimp-search") ) {
      const grid = root.querySelector(`.pcimp-cards[data-kind="${input.dataset.kind}"]`);
      const empty = root.querySelector(`.pcimp-nomatch[data-kind="${input.dataset.kind}"]`);
      const apply = () => {
        const q = input.value.trim().toLowerCase();
        let shown = 0;
        for ( const card of grid?.querySelectorAll(".pcimp-card[data-search]") ?? [] ) {
          const hit = !q || card.dataset.search.includes(q);
          card.hidden = !hit;
          if ( hit ) shown++;
        }
        if ( empty ) empty.hidden = shown > 0;
      };
      input.addEventListener("input", apply);
      input.addEventListener("keydown", ev => { if ( ev.key === "Enter" ) ev.preventDefault(); });
      if ( input.value ) apply();
    }

    // Keep typing in the same chip box after adding one.
    if ( this.pc.focusChip ) {
      root.querySelector(`input[data-chip-add="${this.pc.focusChip}"]`)?.focus();
      this.pc.focusChip = null;
    }

    // Chip inputs: Enter adds; picking a suggestion adds straight away.
    for ( const input of root.querySelectorAll("input[data-chip-add]") ) {
      const field = input.dataset.chipAdd;
      const options = new Set([...root.querySelectorAll(`#pcimp-dl-${field} option`)].map(o => o.value));
      input.addEventListener("keydown", ev => {
        if ( ev.key !== "Enter" ) return;
        ev.preventDefault();
        this.#addChip(field, input.value);
      });
      input.addEventListener("input", () => { if ( options.has(input.value) ) this.#addChip(field, input.value); });
    }
  }

  #addChip(field, value) {
    const v = String(value ?? "").trim();
    if ( !v ) return;
    const list = splitList(this.pc[field]);
    if ( !list.some(x => x.toLowerCase() === v.toLowerCase()) ) list.push(v);
    this.pc[field] = joinList(list);
    this.pc.focusChip = field;
    this.render();
  }

  /* ------------------------------------------------------------ */
  /*  Paste → data                                                */
  /* ------------------------------------------------------------ */

  async applyPaste(text) {
    const p = parseCharacter(text);
    const s = this.pc;
    const warnings = [...p.warnings];
    if ( p.rules ) s.rules = p.rules;
    const rules = p.rules || (s.rules === "any" ? defaultRules() : s.rules);
    if ( p.name ) s.name = p.name;

    if ( p.species ) {
      const hit = await CompendiumIndex.find("race", p.species, rules)
        ?? await CompendiumIndex.find("race", p.species.split(/\s+/).at(-1), rules);
      if ( hit ) s.speciesUuid = hit.uuid; else warnings.push(game.i18n.format("PCIMP.NotFound", { type: "species", name: p.species }));
    }
    if ( p.background ) {
      const hit = await CompendiumIndex.find("background", p.background, rules);
      if ( hit ) s.backgroundUuid = hit.uuid; else warnings.push(game.i18n.format("PCIMP.NotFound", { type: "background", name: p.background }));
    }
    if ( p.classes.length ) {
      s.classes = [];
      for ( const c of p.classes ) {
        const cls = await CompendiumIndex.find("class", c.name, rules);
        if ( !cls ) { warnings.push(game.i18n.format("PCIMP.NotFound", { type: "class", name: c.name })); continue; }
        let sub = null;
        if ( c.subclass ) {
          sub = await CompendiumIndex.find("subclass", c.subclass, rules, { classIdentifier: cls.identifier })
            ?? await findSubclassLoose(c.subclass, cls.identifier, rules);
          if ( !sub ) warnings.push(game.i18n.format("PCIMP.NotFound", { type: "subclass", name: c.subclass }));
        }
        s.classes.push({ uuid: cls.uuid, subclassUuid: sub?.uuid ?? "", levels: c.levels });
      }
      if ( !s.classes.length ) s.classes = [blankClass()];
      s.activeClass = 0;
    }
    if ( Object.keys(p.abilities).length ) {
      s.method = "manual";
      Object.assign(s.abilities, p.abilities);
      s.finalScores = true;
    }
    for ( const f of ["skills", "expertise", "languages", "tools", "armor", "weapons", "feats", "spells"] ) {
      if ( p[f].length ) s[f] = joinList(p[f]);
    }
    if ( p.equipment.length ) s.equipment = joinList(p.equipment.map(e => e.quantity > 1 ? `${e.quantity} ${e.name}` : e.name));
    if ( Object.keys(p.senses).length ) s.senses = joinList(Object.entries(p.senses).map(([k, v]) => `${k} ${v}`));
    if ( Object.keys(p.currency).length ) s.currency = joinList(Object.entries(p.currency).map(([k, v]) => `${v} ${k}`));
    s.parseWarnings = warnings;
    s.tab = "review";
  }

  /* ------------------------------------------------------------ */
  /*  Handlers                                                    */
  /* ------------------------------------------------------------ */

  static async #onChange(event, form, formData) {
    const target = event?.target;
    // Search boxes and chip inputs handle themselves.
    if ( target?.classList?.contains("pcimp-search") ) return;
    if ( target?.dataset?.chipAdd ) return this.#addChip(target.dataset.chipAdd, target.value);

    const data = foundry.utils.expandObject(formData.object);
    const s = this.pc;
    for ( const k of ["paste", "name", "img", "senses", "currency"] ) if ( k in data ) s[k] = data[k] ?? "";
    if ( "finalScores" in data ) s.finalScores = !!data.finalScores;
    if ( data.abilities ) {
      for ( const a of ABILITIES ) {
        if ( !(a in data.abilities) ) continue;
        const value = Number(data.abilities[a]) || 0;
        // Standard array: picking a value another ability holds swaps the two.
        if ( s.method === "standard" && target?.name === `abilities.${a}` ) {
          const other = ABILITIES.find(o => o !== a && Number(s.abilities[o]) === value);
          if ( other ) s.abilities[other] = s.abilities[a];
        }
        s.abilities[a] = value;
      }
    }
    if ( data.classLevel !== undefined ) {
      const row = s.classes[s.activeClass];
      if ( row ) row.levels = Math.clamp(Number(data.classLevel) || 1, 1, 20);
    }
    if ( s.method === "pointbuy" ) for ( const a of ABILITIES ) s.abilities[a] = Math.clamp(s.abilities[a], 8, 15);
    if ( target?.name !== "paste" && target?.name !== "name" ) this.render();
  }

  static #onTab(event, target) { this.pc.tab = target.dataset.tab; this.render(); }
  static #onNext() { this.pc.tab = TABS[Math.min(TABS.indexOf(this.pc.tab) + 1, TABS.length - 1)]; this.render(); }
  static #onPrev() { this.pc.tab = TABS[Math.max(TABS.indexOf(this.pc.tab) - 1, 0)]; this.render(); }

  static #onSetRules(event, target) { this.pc.rules = target.dataset.rules; this.render(); }

  static #onPick(event, target) {
    const { field, uuid } = target.dataset;
    const s = this.pc;
    const toggle = cur => (cur === uuid ? "" : uuid);
    if ( field === "species" ) s.speciesUuid = toggle(s.speciesUuid);
    else if ( field === "background" ) s.backgroundUuid = toggle(s.backgroundUuid);
    else if ( field === "class" ) {
      const row = s.classes[s.activeClass];
      if ( row.uuid !== uuid ) { row.uuid = uuid; row.subclassUuid = ""; }
    }
    else if ( field === "subclass" ) s.classes[s.activeClass].subclassUuid = uuid ? toggle(s.classes[s.activeClass].subclassUuid) : "";
    this.render();
  }

  static #onSetActiveClass(event, target) { this.pc.activeClass = Number(target.dataset.index); this.render(); }
  static #onAddClass() {
    this.pc.classes.push(blankClass());
    this.pc.activeClass = this.pc.classes.length - 1;
    this.render();
  }
  static #onRemoveClass(event, target) {
    event.stopPropagation();
    this.pc.classes.splice(Number(target.dataset.index), 1);
    if ( !this.pc.classes.length ) this.pc.classes.push(blankClass());
    this.pc.activeClass = 0;
    this.render();
  }
  static #onLevelStep(event, target) {
    const row = this.pc.classes[this.pc.activeClass];
    row.levels = Math.clamp((Number(row.levels) || 1) + Number(target.dataset.delta), 1, 20);
    this.render();
  }

  static #onSetMethod(event, target) {
    const s = this.pc;
    s.method = target.dataset.method;
    // Switching method resets to a legal spread.
    if ( s.method === "standard" ) s.abilities = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
    if ( s.method === "pointbuy" ) s.abilities = Object.fromEntries(ABILITIES.map(a => [a, 8]));
    s.finalScores = false;
    this.render();
  }

  static #onAbilityStep(event, target) {
    const s = this.pc;
    const { key, delta } = target.dataset;
    const [min, max] = s.method === "pointbuy" ? [8, 15] : [1, 30];
    s.abilities[key] = Math.clamp((Number(s.abilities[key]) || 10) + Number(delta), min, max);
    this.render();
  }

  static #onCycleSkill(event, target) {
    const s = this.pc;
    const label = target.dataset.label;
    const lower = label.toLowerCase();
    const prof = splitList(s.skills).filter(v => v.toLowerCase() !== lower);
    const expert = splitList(s.expertise).filter(v => v.toLowerCase() !== lower);
    const level = Number(target.dataset.level);   // 0 → 1 → 2 → 0
    if ( level === 0 ) prof.push(label);
    else if ( level === 1 ) expert.push(label);
    s.skills = joinList(prof);
    s.expertise = joinList(expert);
    this.render();
  }

  static #onAddChip(event, target) {
    const field = target.dataset.field;
    const input = this.element.querySelector(`input[data-chip-add="${field}"]`);
    this.#addChip(field, input?.value);
  }
  static #onRemoveChip(event, target) {
    const { field, index } = target.dataset;
    const list = splitList(this.pc[field]);
    list.splice(Number(index), 1);
    this.pc[field] = joinList(list);
    this.render();
  }

  static async #onParse() {
    const text = this.element.querySelector("textarea[name=paste]")?.value ?? this.pc.paste;
    this.pc.paste = text;
    if ( !text.trim() ) return ui.notifications.warn(game.i18n.localize("PCIMP.PasteEmpty"));
    await this.applyPaste(text);
    this.render();
  }

  static #onReloadLists() {
    CompendiumIndex.reset();
    this.classInfo = {};
    this.descriptions.clear();
    this.render();
  }

  static #onReset() { this.pc = PCImporterWizard.blankState(); this.render(); }

  static async #onCreate(event, target) {
    const s = this.pc;
    if ( !s.classes[0]?.uuid ) return ui.notifications.warn(game.i18n.localize("PCIMP.NeedClass"));
    if ( s.method === "standard" && !s.finalScores ) {
      const used = ABILITIES.map(a => Number(s.abilities[a]));
      if ( [...used].sort((a, b) => b - a).join() !== STANDARD_ARRAY.join() ) {
        return ui.notifications.warn(game.i18n.localize("PCIMP.ArrayInvalid"));
      }
    }
    if ( s.method === "pointbuy" ) {
      const spent = ABILITIES.reduce((t, a) => t + (POINT_BUY_COST[s.abilities[a]] ?? 99), 0);
      if ( spent > POINT_BUY_BUDGET ) return ui.notifications.warn(game.i18n.localize("PCIMP.PointsOver"));
    }
    for ( const c of s.classes ) if ( c.uuid ) await this.#classInfo(c.uuid);
    const all = (await Promise.all(["race", "background", "class", "subclass"].map(t => CompendiumIndex.list(t, "any")))).flat();
    const picked = [s.speciesUuid, s.backgroundUuid, ...s.classes.flatMap(c => [c.uuid, c.subclassUuid])]
      .filter(Boolean).map(u => all.find(e => e.uuid === u));
    const rules = s.rules === "any" ? detectRules(picked).rules : s.rules;
    target.disabled = true;
    await this.minimize();
    try {
      await importCharacter(this.toBuild(rules));
      await this.close();
    } catch(err) {
      console.error(`${MODULE_ID} |`, err);
      ui.notifications.error(game.i18n.localize("PCIMP.Failed"));
      await this.maximize();
      target.disabled = false;
    }
  }
}

async function findSubclassLoose(name, classIdentifier, rules) {
  const list = (await CompendiumIndex.list("subclass", rules)).filter(e => e.classIdentifier === classIdentifier);
  const words = name.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !["school", "domain", "path", "oath", "college", "circle", "patron", "the"].includes(w));
  return list.find(e => words.some(w => e.name.toLowerCase().includes(w))) ?? null;
}

function signed(n) { return n >= 0 ? `+${n}` : `${n}`; }
