# PC 5/5.5e Importer

A Foundry VTT module for the D&D 5e system that **imports player characters** and **levels them up**. It brings in only what makes up the PC — species, background, class, subclass, feats, equipment, spells and traits (skills, expertise, languages, tools, armor and weapon proficiencies, senses, currency). Nothing else.

Works with **2014 (5e)** and **2024 (5.5e)** content, including your own homebrew compendiums.

## Features

**Import a PC** — the *Import PC* button at the top of the Actors sidebar opens a five-step wizard:

1. **Paste** — paste a character sheet and press *Read sheet*. Recognised lines fill in the other tabs. Skip this tab to build from scratch.
2. **Species, Background & Class** — pick from your compendiums, filtered by rules version. Import at level 1, set a higher level, or add multiclass rows.
3. **Ability Scores** — Standard Array, Point Buy (27 points) or Manual/Rolled. Your class's primary abilities are starred.
4. **Items & Traits** — extra feats, equipment, spells and proficiencies not already granted by your choices.
5. **Review** — shows what was found in which compendium, what will become a placeholder, and the rules version detected.

*Create character* then runs the dnd5e advancement flow for each item in order — species → background → class → subclass → feats — so hit points, ability increases, skill and feat choices, subclass picks and spells follow each item's own rules, the same as dropping it on a sheet.

**Level up** — a ⏫ button appears next to the short/long rest buttons on every character sheet (also in the sheet's header menu). Level an existing class or multiclass into a new one, with a preview of character level, proficiency bonus, hit die, average HP and ASI levels, plus multiclass ability-requirement warnings.

## Paste format

Labelled lines, in any order. Lines without a label continue the previous section.

```
Name: Tyrla
Rules: 2024
Species: Elf
Background: Sage
Class: Wizard 3 (School of Evocation)
STR 8 DEX 14 CON 13 INT 15 WIS 12 CHA 10
Skills: Arcana, History, Insight*        (* = expertise)
Languages: Common, Elvish, Draconic
Tools: Calligrapher's Supplies
Senses: Darkvision 60
Feats: Magic Initiate
Equipment: Quarterstaff, Spellbook, 2 Daggers, Rope x1
Spells:
Cantrips: Fire Bolt, Light, Mage Hand
1st: Magic Missile, Shield
Currency: 15 gp, 3 sp
```

Multiclass: `Class: Fighter 3 / Wizard (Evocation) 2`. Pasted ability scores are treated as final scores.

## Settings

- **Compendiums to use** — limit lookups to certain packs (comma-separated IDs). Blank = all Item compendiums.
- **Create placeholders for unknown items** — keep unmatched items/feats/spells as blank items so nothing is lost.
- **Players can import** — show *Import PC* to players allowed to create actors.
- **Level Up button** — show the button on character sheets.

## API

```js
PCImporter.openWizard({ initialName: "Tyrla" });
PCImporter.importFromText(text);     // opens the wizard pre-filled from pasted text
PCImporter.openLevelUp(actor);
PCImporter.parseCharacter(text);     // returns the parsed build object
```

## Install

Manifest URL:

```
https://github.com/siller94-art/pc-5e-importer/releases/latest/download/module.json
```

Requires Foundry VTT v14 and dnd5e 5.3+.
