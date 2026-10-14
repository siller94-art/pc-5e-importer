/**
 * Thin wrappers around the dnd5e AdvancementManager so the importer can await each step.
 * The system's own manager does all the rules work (HP, ASIs, feats, trait choices,
 * subclass picks, item grants, spell choices) for both 2014 and 2024 content.
 */

function Manager() {
  return dnd5e.applications.advancement.AdvancementManager;
}

/**
 * Render a manager and resolve when it finishes or is closed.
 * @returns {Promise<boolean>} true if the advancement completed, false if cancelled.
 */
function runManager(manager) {
  return new Promise(resolve => {
    let done = false;
    const hookId = Hooks.on("dnd5e.advancementManagerComplete", app => {
      if ( app === manager ) done = true;
    });
    const close = manager.close.bind(manager);
    manager.close = async (...args) => {
      const result = await close(...args);
      Hooks.off("dnd5e.advancementManagerComplete", hookId);
      resolve(done);
      return result;
    };
    manager.render({ force: true });
  });
}

/**
 * Add an item to an actor, running its advancements if it has any.
 * @param {Actor5e} actor
 * @param {object} itemData   Item source data (class items may set system.levels for the target level).
 * @returns {Promise<boolean>}
 */
export async function addWithAdvancement(actor, itemData) {
  const manager = Manager().forNewItem(actor, itemData);
  if ( manager.steps.length ) return runManager(manager);
  await actor.createEmbeddedDocuments("Item", [itemData]);
  return true;
}

/**
 * Change a class's level through the advancement flow.
 * @param {Actor5e} actor
 * @param {Item5e} classItem
 * @param {number} delta
 */
export async function changeClassLevel(actor, classItem, delta) {
  const manager = Manager().forLevelChange(actor, classItem.id, delta);
  if ( manager.steps.length ) return runManager(manager);
  await classItem.update({ "system.levels": classItem.system.levels + delta });
  return true;
}
