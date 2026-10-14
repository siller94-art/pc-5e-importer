import { MODULE_ID, ABILITIES, STANDARD_ARRAY, POINT_BUY_COST, POINT_BUY_BUDGET } from "./constants.mjs";
import { CompendiumIndex, detectRules, defaultRules } from "./compendium.mjs";
import { parseCharacter, parseQuantity } from "./parser.mjs";
import { importCharacter } from "./importer.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TABS = ["paste", "identity", "abilities", "extras", "review"];
const LIST_FIELDS = ["skills", "expertise", "languages", "tools", "armor", "weapons", "feats", "equipment", "spells"];

/**
 * Level-1 (or any level) PC importer: paste a sheet and/or pick everything from compendiums,
 * then hand it to the dnd5e advancement flow.
 */
export class PCImporterWizard extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options={}) {
    super(options);
    this.state = PCImporterWizard.blankState(options.initialName);
    this.classInfo = {};
  }

  static blankState(name="") {
    return {
      tab: "paste", paste: "", name, img: "", rules: "any",
      speciesUuid: "", backgroundUuid: "",
      classes: [{ uuid: "", subclassUuid: "", levels: 1 }],
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
    position: { width: 760, height: 720 },
    form: { handler: PCImporterWizard.#onChange, submitOnChange: true, closeOnSubmit: false },
    actions: {
      tab: PCImporterWizard.#onTab,
      parse: PCImporterWizard.#onParse,
      next: PCImporterWizard.#onNext,
      prev: PCImporterWizard.#onPrev,
      addClass: PCImporterWizard.#onAddClass,
      removeClass: PCImporterWizard.#onRemoveClass,
      reset: PCImporterWizard.#onReset,
      create: PCImporterWizard.#onCreate
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/wizard.hbs`, scrollable: [".pcimp-body"] }
  };

  /* ------------------------------------------------------------ */

  get rulesFilter() { return this.state.rules; }

  async _prepareContext() {
    const s = this.state;
    if ( !CompendiumIndex.ready ) {
      // Open the window straight away; fill it in once the compendiums are indexed.
      CompendiumIndex.load()
        .then(() => this.rendered && this.render())
        .catch(err => {
          console.error(`${MODULE_ID} |`, err);
          ui.notifications.error(`PC Importer: ${err?.message ?? err}`);
        });
      return {
        loading: true, state: s,
        tabs: TABS.map((id, i) => ({ id, number: i + 1, label: `PCIMP.Tab.${id}`, active: s.tab === id })),
        isFirstTab: true, isLastTab: false
      };
    }
    const rules = this.rulesFilter;
    const opt = (list, selected) => list.map(e => ({
      value: e.uuid, label: e.rules ? `${e.name} (${e.rules})` : e.name, selected: e.uuid === selected, pack: e.pack
    }));

    const [species, backgrounds, classes, subclasses] = await Promise.all([
      CompendiumIndex.list("race", rules), CompendiumIndex.list("background", rules),
      CompendiumIndex.list("class", rules), CompendiumIndex.list("subclass", rules)
    ]);
    const byUuid = new Map([...species, ...backgrounds, ...classes, ...subclasses].map(e => [e.uuid, e]));

    const classRows = [];
    for ( const [i, row] of s.classes.entries() ) {
      const cls = byUuid.get(row.uuid);
      const subs = cls ? subclasses.filter(e => e.classIdentifier === cls.identifier) : [];
      const info = row.uuid ? await this.#classInfo(row.uuid) : null;
      classRows.push({
        index: i, levels: row.levels, first: i === 0,
        classOptions: opt(classes, row.uuid), subclassOptions: opt(subs, row.subclassUuid),
        hd: info?.hd ?? "", primary: info?.primaryLabel ?? ""
      });
    }

    // Abilities
    const primary = new Set(s.classes.flatMap(c => this.classInfo[c.uuid]?.primary ?? []));
    const used = Object.values(s.abilities).map(Number);
    const abilities = ABILITIES.map(key => {
      const value = Number(s.abilities[key]) || 0;
      const options = STANDARD_ARRAY.map(v => ({ value: v, selected: v === value }));
      return {
        key, value, options,
        label: CONFIG.DND5E.abilities[key]?.label ?? key.toUpperCase(),
        mod: signed(Math.floor((value - 10) / 2)),
        primary: primary.has(key)
      };
    });
    const pointsSpent = used.reduce((t, v) => t + (POINT_BUY_COST[v] ?? 99), 0);
    const arrayValid = STANDARD_ARRAY.every(v => used.filter(u => u === v).length === STANDARD_ARRAY.filter(a => a === v).length);

    const totalLevel = s.classes.reduce((t, c) => t + (Number(c.levels) || 0), 0);
    const firstInfo = this.classInfo[s.classes[0]?.uuid];
    const conMod = Math.floor(((Number(s.abilities.con) || 10) - 10) / 2);

    const context = {
      state: s,
      tabs: TABS.map((id, i) => ({ id, number: i + 1, label: `PCIMP.Tab.${id}`, active: s.tab === id })),
      tab: Object.fromEntries(TABS.map(t => [t, s.tab === t])),
      isFirstTab: s.tab === TABS[0], isLastTab: s.tab === TABS.at(-1),
      rulesOptions: [
        { value: "any", label: "PCIMP.Rules.any" }, { value: "2014", label: "PCIMP.Rules.2014" },
        { value: "2024", label: "PCIMP.Rules.2024" }
      ].map(o => ({ ...o, selected: o.value === s.rules })),
      speciesOptions: opt(species, s.speciesUuid),
      backgroundOptions: opt(backgrounds, s.backgroundUuid),
      classRows,
      methodOptions: ["standard", "pointbuy", "manual"].map(m => ({
        value: m, label: `PCIMP.Method.${m}`, selected: m === s.method
      })),
      method: { standard: s.method === "standard", pointbuy: s.method === "pointbuy", manual: s.method === "manual" },
      abilities,
      pointsSpent, pointsLeft: POINT_BUY_BUDGET - pointsSpent, pointsOver: pointsSpent > POINT_BUY_BUDGET, pointBuyBudget: POINT_BUY_BUDGET,
      arrayValid,
      preview: {
        level: totalLevel,
        prof: signed(Math.ceil(Math.max(totalLevel, 1) / 4) + 1),
        hp1: firstInfo?.hdMax ? firstInfo.hdMax + conMod : null
      },
      packCount: CompendiumIndex.packs.length
    };
    if ( s.tab === "review" ) context.review = await this.#review(byUuid);
    return context;
  }

  async #classInfo(uuid) {
    if ( this.classInfo[uuid] ) return this.classInfo[uuid];
    const doc = await fromUuid(uuid);
    const primary = Array.from(doc?.system?.primaryAbility?.value ?? []);
    const hd = doc?.system?.hd?.denomination ?? "";
    return this.classInfo[uuid] = {
      primary, hd, hdMax: Number(hd.replace("d", "")) || 0,
      primaryLabel: primary.map(a => CONFIG.DND5E.abilities[a]?.label ?? a).join(" / ")
    };
  }

  /** Resolve everything the way the importer will, so the user can see what will and won't land. */
  async #review(byUuid) {
    const s = this.state;
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
    const physical = ["weapon", "equipment", "consumable", "tool", "loot", "container"];
    const core = [
      { label: "PCIMP.Species", entry: byUuid.get(s.speciesUuid) },
      { label: "PCIMP.Background", entry: byUuid.get(s.backgroundUuid) },
      ...s.classes.map(c => ({ label: "PCIMP.Class", entry: byUuid.get(c.uuid), levels: c.levels })),
      ...s.classes.filter(c => c.subclassUuid).map(c => ({ label: "PCIMP.Subclass", entry: byUuid.get(c.subclassUuid) }))
    ];
    return {
      rules, mixed,
      core: core.map(c => ({ ...c, name: c.entry?.name, entryRules: c.entry?.rules, missing: !c.entry })),
      lists: [
        { title: "PCIMP.Feats", rows: await resolve("feat", build.feats) },
        { title: "PCIMP.Equipment", rows: await resolve(physical, build.equipment) },
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

  /** Turn wizard state into the importer's build object. */
  toBuild(rules) {
    const s = this.state;
    const list = f => String(s[f] ?? "").split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
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
      classes: s.classes.filter(c => c.uuid).map(c => ({ ...c, levels: Number(c.levels) || 1 })),
      skills: list("skills"), expertise: list("expertise"), languages: list("languages"),
      tools: list("tools"), armor: list("armor"), weapons: list("weapons"),
      feats: list("feats"), equipment: list("equipment").map(parseQuantity), spells: list("spells"),
      senses, currency
    };
  }

  /* ------------------------------------------------------------ */
  /*  Paste → state                                               */
  /* ------------------------------------------------------------ */

  async applyPaste(text) {
    const p = parseCharacter(text);
    const s = this.state;
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
      if ( !s.classes.length ) s.classes = [{ uuid: "", subclassUuid: "", levels: 1 }];
    }
    if ( Object.keys(p.abilities).length ) {
      s.method = "manual";
      Object.assign(s.abilities, p.abilities);
      s.finalScores = true;
    }
    for ( const f of ["skills", "expertise", "languages", "tools", "armor", "weapons", "feats", "spells"] ) {
      if ( p[f].length ) s[f] = p[f].join(", ");
    }
    if ( p.equipment.length ) s.equipment = p.equipment.map(e => e.quantity > 1 ? `${e.quantity} ${e.name}` : e.name).join(", ");
    if ( Object.keys(p.senses).length ) s.senses = Object.entries(p.senses).map(([k, v]) => `${k} ${v}`).join(", ");
    if ( Object.keys(p.currency).length ) s.currency = Object.entries(p.currency).map(([k, v]) => `${v} ${k}`).join(", ");
    s.parseWarnings = warnings;
    s.tab = "review";
  }

  /* ------------------------------------------------------------ */
  /*  Handlers                                                    */
  /* ------------------------------------------------------------ */

  static async #onChange(event, form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const s = this.state;
    for ( const k of ["paste", "name", "img", "rules", "speciesUuid", "backgroundUuid", "method",
      "senses", "currency", ...LIST_FIELDS] ) {
      if ( k in data ) s[k] = data[k] ?? "";
    }
    if ( "finalScores" in data ) s.finalScores = !!data.finalScores;
    if ( data.abilities ) {
      for ( const a of ABILITIES ) if ( a in data.abilities ) s.abilities[a] = Number(data.abilities[a]) || 0;
    }
    if ( data.classes ) {
      for ( const [i, row] of Object.entries(data.classes) ) {
        const cur = s.classes[Number(i)];
        if ( !cur ) continue;
        if ( row.uuid !== undefined && row.uuid !== cur.uuid ) { cur.uuid = row.uuid; cur.subclassUuid = ""; }
        else if ( row.subclassUuid !== undefined ) cur.subclassUuid = row.subclassUuid;
        if ( row.levels !== undefined ) cur.levels = Math.clamp(Number(row.levels) || 1, 1, 20);
      }
    }
    // Switching method resets to a legal spread.
    if ( event?.target?.name === "method" ) {
      if ( s.method === "standard" ) s.abilities = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
      if ( s.method === "pointbuy" ) s.abilities = Object.fromEntries(ABILITIES.map(a => [a, 8]));
    }
    if ( s.method === "pointbuy" ) for ( const a of ABILITIES ) s.abilities[a] = Math.clamp(s.abilities[a], 8, 15);
    if ( event?.target?.name !== "paste" ) this.render();
  }

  static #onTab(event, target) { this.state.tab = target.dataset.tab; this.render(); }
  static #onNext() { this.state.tab = TABS[Math.min(TABS.indexOf(this.state.tab) + 1, TABS.length - 1)]; this.render(); }
  static #onPrev() { this.state.tab = TABS[Math.max(TABS.indexOf(this.state.tab) - 1, 0)]; this.render(); }

  static async #onParse() {
    const text = this.element.querySelector("textarea[name=paste]")?.value ?? this.state.paste;
    this.state.paste = text;
    if ( !text.trim() ) return ui.notifications.warn(game.i18n.localize("PCIMP.PasteEmpty"));
    await this.applyPaste(text);
    this.render();
  }

  static #onAddClass() { this.state.classes.push({ uuid: "", subclassUuid: "", levels: 1 }); this.render(); }
  static #onRemoveClass(event, target) {
    this.state.classes.splice(Number(target.dataset.index), 1);
    if ( !this.state.classes.length ) this.state.classes.push({ uuid: "", subclassUuid: "", levels: 1 });
    this.render();
  }
  static #onReset() { this.state = PCImporterWizard.blankState(); this.render(); }

  static async #onCreate(event, target) {
    const s = this.state;
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
    const byUuid = new Map();
    for ( const u of [s.speciesUuid, s.backgroundUuid, ...s.classes.flatMap(c => [c.uuid, c.subclassUuid])] ) {
      if ( !u ) continue;
      const db = await CompendiumIndex.load();
      for ( const list of Object.values(db) ) { const e = list.find(x => x.uuid === u); if ( e ) byUuid.set(u, e); }
    }
    const rules = s.rules === "any" ? detectRules([...byUuid.values()]).rules : s.rules;
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
