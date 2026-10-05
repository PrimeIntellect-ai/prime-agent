---
name: simplified-technical-english
description: Write technical prose in Simplified Technical English - simple verb forms, active voice, short sentences, one word one sense, no vague fillers, plus a substitutions table and a final check step. Use when you write or revise technical documentation, procedures, error messages, or reports, or when the user asks for plain technical writing.
---

# Simplified Technical English

This skill is based on the ASD-STE100 specification rules. The approved-word
dictionary is proprietary to ASD and intentionally not included. What follows
is our own distillation of the rules.

## Scope

Apply this skill to technical prose: documentation, procedures, error
messages, and reports.

Do not apply it to code blocks, identifiers, commands, file paths, quoted
text, or product names. Keep such text exactly as it is. A conversational
reply does not need these rules. A user-requested style wins over this skill.

## Verb rules

- Use simple tenses only: infinitive, imperative, simple present, simple
  past, and will.
- Do not use -ing verb forms. Write "the build writes the log", not "the
  build is writing the log".
- Use the active voice and state the actor. Write "the CLI writes the
  config", not "the config is written by the CLI".
- Use the imperative for procedures. Write "restart the daemon", not "the
  daemon should be restarted".
- Use only `can`, `must`, and `will` as helping verbs. Do not use
  `should`, `would`, `may`, `might`, or `shall`.

## Sentence rules

- Keep procedural sentences to 20 words or fewer.
- Keep descriptive sentences to 25 words or fewer.
- Give each sentence one instruction or one topic.
- Do not join two sentences with a semicolon. Write two sentences.
- Do not use contractions. Write "do not", not "don't".
- Put a comma after a leading condition: "if the build fails, read the log."
- Use a vertical list for complex steps or long conditions.

## Word rules

- Use each word in one sense only. Keep the same word for the same thing
  through one document.
- Do not use phrasal verbs. Write "start", not "kick off". Write "find",
  not "track down".
- Keep noun clusters to three words or fewer. Write "the startup time of
  the kernel", not "kernel initialization startup time configuration".
- Do not use vague quantity words. State the number or name the set: "three
  timeouts", not "several timeouts".
- Use American spelling. Write "color", not "colour".
- Keep technical names and established terminology verbatim. Do not rename
  a command, a flag, an API, or an established term for the sake of plain
  language.

## Substitutions

Replace the vague or inflated construction with the plain form.

| Do not write | Write |
| --- | --- |
| utilize | use |
| leverage | use |
| facilitate | help |
| in order to | to |
| prior to | before |
| subsequent to | after |
| ensure | make sure |
| attempt | try |
| multiple | the number stated, for example "three files" |
| several | the number stated |
| various | the number stated, or the named set |
| due to the fact that | because |
| in the event that | if |
| at this point in time | now |
| carry out | do |
| has the ability to | can |
| is able to | can |
| it is important to note | delete the phrase |
| please note that | delete the phrase |
| in the near future | soon |

## Check step

After you write, scan the text and fix each find:

1. Scan for semicolons. Split each joined pair into two sentences.
2. Scan for contractions. Expand each one.
3. Scan for `should`, `would`, `may`, `might`, and `shall`. Rewrite each
   sentence with `can`, `must`, `will`, or a simple verb.
4. Scan for unapproved -ing verb forms and helping-verb-plus-participle
   forms such as "is running", "was completed", "has started". Rewrite each
   in a simple tense.
5. Scan for the entries in the substitutions table. Replace each one.
6. Read the full text again and confirm that the scan is clean. Fix what
   remains and recheck.
