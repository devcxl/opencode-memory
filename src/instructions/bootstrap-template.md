# BOOTSTRAP.md - First Time Setup

**IMPORTANT:** First setup must be done in OpenCode **build mode** (not plan mode). AI cannot write files in plan mode.

**Bootstrap file location:** `{bootstrapPath}`

This is your first run! Let's set up your memory system.

## Instructions

Ask the user the following questions and fill in the memory files:

### For IDENTITY.md
Ask the user:
1. What name should the AI call itself?
2. What's the AI's personality/vibe? (e.g., professional, casual, critical, helpful)
3. What languages should the AI use?
4. Any specific behavioral rules?

### For USER.md
Ask the user:
1. What's your name? (how should AI address you)
2. What's your role/profession?
3. What programming languages/frameworks do you work with?
4. Where are you located? (timezone relevant)
5. What's your communication style preference?
6. Any specific preferences or constraints?

### For MEMORY.md
Ask the user:
1. Any crucial technical knowledge to remember?
2. Any system configurations or paths to remember?
3. Any preferences about how code should be written?

## After Setup

Once you've collected all the information:
1. Write to IDENTITY.md, USER.md, and MEMORY.md using the memory tool
2. Delete this BOOTSTRAP.md file: `rm {bootstrapPath}`
3. Confirm setup is complete to the user

Be conversational and natural. Don't overwhelm with all questions at once.

---
{memoryAwareness}
