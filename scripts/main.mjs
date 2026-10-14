import { MODULE_ID } from "./constants.mjs";
import { CompendiumIndex } from "./compendium.mjs";
import { PCImporterWizard } from "./wizard.mjs";
import { LevelUpApp } from "./level-up.mjs";
import { importCharacter } from "./importer.mjs";
import { parseCharacter } from "./parser.mjs";

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "packs", {
    name: "PCIMP.Setting.packs.name", hint: "PCIMP.Setting.packs.hint",
    scope: "world", config: true, type: String, default: "",
    onChange: () => CompendiumIndex.reset()
  });
  game.settings.register(MODULE_ID, "placeholders", {
    name: "PCIMP.Setting.placeholders.name", hint: "PCIMP.Setting.placeholders.hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "playerImport", {
    name: "PCIMP.Setting.playerImport.name", hint: "PCIMP.Setting.playerImport.hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "levelUpButton", {
    name: "PCIMP.Setting.levelUpButton.name", hint: "PCIMP.Setting.levelUpButton.hint",
    scope: "world", config: true, type: Boolean, default: true
  });

  const api = {
    openWizard: (options={}) => {
      const open = foundry.applications.instances.get("pc-5e-importer-wizard");
      return Promise.resolve((open ?? new PCImporterWizard(options)).render({ force: true })).catch(showError);
    },
    openLevelUp: actor => {
      const open = foundry.applications.instances.get(`pc-5e-importer-levelup-${actor.id}`);
      return Promise.resolve((open ?? new LevelUpApp(actor)).render({ force: true })).catch(showError);
    },
    importFromText: async text => {
      const app = foundry.applications.instances.get("pc-5e-importer-wizard") ?? new PCImporterWizard();
      await app.applyPaste(text);
      return app.render({ force: true });
    },
    importCharacter,
    parseCharacter,
    resetIndex: () => CompendiumIndex.reset()
  };
  game.modules.get(MODULE_ID).api = api;
  globalThis.PCImporter = api;
});

function showError(err) {
  console.error(`${MODULE_ID} |`, err);
  ui.notifications.error(`PC Importer: ${err?.message ?? err}`);
}

Hooks.on("createCompendium", () => CompendiumIndex.reset());
Hooks.on("deleteCompendium", () => CompendiumIndex.reset());
Hooks.on("updateCompendium", () => CompendiumIndex.reset());

/* -------------------------------------------- */
/*  Actors directory: "Import PC" button        */
/* -------------------------------------------- */

function canImport() {
  if ( game.user.isGM ) return true;
  return game.settings.get(MODULE_ID, "playerImport") && game.user.can("ACTOR_CREATE");
}

Hooks.on("renderActorDirectory", (app, html) => {
  if ( game.system.id !== "dnd5e" || !canImport() ) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if ( root.querySelector(".pcimp-open") ) return;
  const actions = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
  if ( !actions ) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pcimp-open";
  button.innerHTML = `<i class="fa-solid fa-user-plus"></i> ${game.i18n.localize("PCIMP.OpenButton")}`;
  button.addEventListener("click", () => game.modules.get(MODULE_ID).api.openWizard());
  actions.append(button);
});

/* -------------------------------------------- */
/*  Character sheet: Level Up button            */
/* -------------------------------------------- */

function canLevel(actor) {
  return game.settings.get(MODULE_ID, "levelUpButton")
    && actor?.type === "character" && actor.isOwner
    && actor.items.some(i => i.type === "class")
    && (actor.system.details.level ?? 0) < 20;
}

// Next to the short/long rest buttons, like Hero Mancer.
Hooks.on("renderCharacterActorSheet", (app, html) => {
  const actor = app.document ?? app.actor;
  if ( !canLevel(actor) ) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if ( root.querySelector(".pcimp-levelup-btn") ) return;
  const rests = root.querySelectorAll('[data-action="rest"]');
  const anchor = rests[rests.length - 1];
  if ( !anchor ) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gold-button pcimp-levelup-btn";
  button.dataset.tooltip = "PCIMP.LevelUp";
  button.setAttribute("aria-label", game.i18n.localize("PCIMP.LevelUp"));
  button.innerHTML = `<i class="fa-solid fa-angles-up"></i>`;
  button.addEventListener("click", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    game.modules.get(MODULE_ID).api.openLevelUp(actor);
  });
  anchor.after(button);
});

// Fallback in the window header menu, for sheets that do not show rest buttons.
Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  const actor = app.document;
  if ( !(actor instanceof Actor) || !canLevel(actor) ) return;
  const open = () => game.modules.get(MODULE_ID).api.openLevelUp(actor);
  // Register as an action too, in case the core version ignores onClick on header controls.
  if ( app.options?.actions && !app.options.actions.pcimpLevelUp ) app.options.actions.pcimpLevelUp = open;
  controls.push({
    icon: "fa-solid fa-angles-up",
    label: "PCIMP.LevelUp",
    action: "pcimpLevelUp",
    onClick: open
  });
});
