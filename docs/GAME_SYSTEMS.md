# Game systems

The platform core is rules-agnostic. Campaigns store `systemId` + `systemVersion` (currently `generic-d20` v1). Dice notation, tokens, fog and chat don't depend on any rules system.

Planned (not built): a declarative `GameSystemAdapter` contract (sheet schema, resources, conditions, initiative config, `validateCharacter`, `deriveDisplayStats`) registered from trusted code only. First `generic-d20` sheets, then a 5E SRD adapter with CC-BY attribution for the exact SRD version, then a Mutants & Masterminds–compatible **custom-sheet preset** that ships no book text or trademarks until licensing is reviewed. Uploaded JavaScript plugins will not be supported.
