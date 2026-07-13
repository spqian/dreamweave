"use strict";

// Repeated Title-Cased operational states are not people. The corpus wide net may
// reinforce a person that has at least one structural person context, but casing
// and recurrence alone must never mint person hubs.

const English = require("../src/langsvc.English");

const statusFacts = [
  "PQOnline Prod Canary progressed to Medium Awaiting Promotion.",
  "PPVNet Prod Medium progressed to Large Awaiting Promotion.",
  "PQOnline Prod Canary remains at Medium Awaiting Promotion.",
  "PPVNet Prod Medium remains at Large Awaiting Promotion.",
  "The report recorded Prod Primary and a Potential Fork candidate.",
  "The next report still recorded Prod Primary and the Potential Fork candidate.",
];

const falsePeople = new Set([
  "person:large-awaiting",
  "person:medium-awaiting",
  "person:prod-canary",
  "person:awaiting-promotion",
  "person:prod-primary",
  "person:potential-fork",
  "person:prod-medium",
]);

const statusEntities = English.extractEntitiesCorpus(statusFacts, { minFacts: 2 });
const emittedFalsePeople = statusEntities.filter((e) => falsePeople.has(e.sig));
if (emittedFalsePeople.length) {
  throw new Error(`status phrases were typed as people: ${emittedFalsePeople.map((e) => e.sig).join(", ")}`);
}

// One structural frame establishes personhood; a neutral repeated mention then
// supplies the second distinct-fact occurrence needed by the recurrence threshold.
const personEntities = English.extractEntitiesCorpus([
  "David Zhang reported the rollout status.",
  "The follow-up note for David Zhang is ready.",
], { minFacts: 2 });
if (!personEntities.some((e) => e.sig === "person:david-zhang")) {
  throw new Error("a structurally-supported recurring person was not extracted");
}

console.log("PASS \u2713 repeated operational status phrases are not mechanically typed as people");
