# Game systems

The platform core is rules-agnostic. Campaigns store `systemId` + `systemVersion`; characters store the adapter id and version they were created with.

## Adapter contract (`shared/game-systems/core.ts`)

Adapters are declarative and registered from trusted code only (`shared/game-systems/registry.ts`). No user-supplied code runs. An adapter declares:

- `sections`: typed fields (`number`, `text`, `textarea`, `resource` {current,max}, `list` of rows with `text`/`number`/`dice` cells). The client renders any adapter's sheet from this, and the server validates against it with a generated Zod schema. **Unknown keys pass through untouched**, so house-rule data survives upgrades.
- `conditionDefinitions`, `initiative`, `diceNotationSupport`, `defaultGridDistance`
- `defaultSheet()`, `validateCharacter()`, `deriveDisplayStats()`, `initiativeModifier()`, `migrate(fromVersion, sheet)`

## Shipped

**generic-d20 v1**: identity, HP/temp HP/AC/speed/initiative/proficiency, six abilities with derived modifiers, attacks and powers with rollable dice cells, named resources, free-form custom stats, features and notes. It contains no rulebook text.

## Planned

A 5E SRD adapter (with CC-BY attribution for the exact SRD version), and a Mutants & Masterminds–compatible custom-sheet preset that ships no book text or trademarks until licensing is reviewed.
