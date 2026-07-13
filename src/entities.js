"use strict";

// Entity layer for the dream weave — BACKWARD-COMPATIBILITY SHIM.
//
// This module used to hold all the entity-extraction logic directly. That logic is
// now split in two, behind a pluggable language-service interface (see langsvc.js):
//   - src/sig-utils.js       generic, language-independent signature/label helpers
//   - src/langsvc.English.js the default (English) language service implementation
//
// Existing callers that `require("./entities")` keep working unchanged: this file
// re-exports the generic helpers plus the DEFAULT language service's extraction
// functions. Code that needs a CALLER-INJECTED (e.g. test) language service should
// go through langsvc.resolve(opts.languageService) instead of this module — see
// dream.js's weave()/applyEntities() for the pattern.
const sigUtils = require("./sig-utils");
const langsvc = require("./langsvc");

const defaultLang = langsvc.defaultService();

const { ENTITY_PREFIXES, labelOf, typeOf } = sigUtils;
const normalize = (s) => defaultLang.normalize(s);
const slug = (s) => defaultLang.slug(s);
const buildVocab = (entityRows, lang) => sigUtils.buildVocab(entityRows, lang || defaultLang);
const formsFor = (sig) => defaultLang.formsFor(sig);
const extractEntities = (fact) => defaultLang.extractEntities(fact);
const extractEntitiesCorpus = (facts, opts) => defaultLang.extractEntitiesCorpus(facts, opts);
const coMentions = (factText, vocab) => defaultLang.coMentions(factText, vocab);

module.exports = { ENTITY_PREFIXES, buildVocab, extractEntities, extractEntitiesCorpus, coMentions, formsFor, typeOf, labelOf, normalize, slug };
