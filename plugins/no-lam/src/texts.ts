// SPDX-License-Identifier: AGPL-3.0-only
// Every label and reason code of the samordnet rapportering plugin in sv, en and nb.

type Texts = Record<string, string>;

const nb: Texts = {
  "lam.scheme": "Samordnet rapportering (grunnlag for LAM)",
  "lam.config.allidrett": "Idretten til allidrettsgruppene (barneidrettsskole)",
  "lam.members": "Medlemmer per 31.12",
  "lam.members_total": "Medlemmer per 31.12 i alt",
  "lam.active": "Aktive medlemmer per gren",
  "lam.disability": "Aktive med funksjonsnedsettelse per gren",
  "lam.allidrett": "Medlemmer i allidrett",
  "lam.target": "LAM-målgruppene (barn 6–12, ungdom 13–19)",
  "lam.counted": "Tellet som medlem",
  "lam.active_counted": "Tellet som aktiv",
  "lam.not_member": "Ikke medlem per 31.12",
  "lam.fee_unpaid": "Kontingenten er ikke betalt: telles ikke",
  "lam.fee_unknown": "Klubben fører ikke kontingent i ClubAdmin: kontroller betalingen",
  "lam.no_birth_date": "Fødselsdato mangler",
  "lam.pdf.deadline": "Frist i samordnet rapportering",
  "lam.pdf.source":
    "Tall per 31.12 for samordnet rapportering i KlubbAdmin. Idrettsrådene fordeler LAM etter medlemstall eller aktivitetstall.",
};

const sv: Texts = {
  "lam.scheme": "Samordnad rapportering (underlag för LAM)",
  "lam.config.allidrett": "Idrotten för allidrottsgrupperna (barnidrottsskola)",
  "lam.members": "Medlemmar per 31.12",
  "lam.members_total": "Medlemmar per 31.12 totalt",
  "lam.active": "Aktiva medlemmar per gren",
  "lam.disability": "Aktiva med funktionsnedsättning per gren",
  "lam.allidrett": "Medlemmar i allidrott",
  "lam.target": "LAM:s målgrupper (barn 6–12, ungdom 13–19)",
  "lam.counted": "Räknad som medlem",
  "lam.active_counted": "Räknad som aktiv",
  "lam.not_member": "Inte medlem per 31.12",
  "lam.fee_unpaid": "Avgiften är inte betald: räknas inte",
  "lam.fee_unknown": "Föreningen för inte avgifter i ClubAdmin: kontrollera betalningen",
  "lam.no_birth_date": "Födelsedatum saknas",
  "lam.pdf.deadline": "Sista dag i samordnad rapportering",
  "lam.pdf.source":
    "Tal per 31.12 för samordnad rapportering i KlubbAdmin. Idrottsråden fördelar LAM efter medlemstal eller aktivitetstal.",
};

const en: Texts = {
  "lam.scheme": "Coordinated reporting (basis of LAM)",
  "lam.config.allidrett": "The sport of the all-round sport groups (children's sports school)",
  "lam.members": "Members on 31 December",
  "lam.members_total": "Members on 31 December in total",
  "lam.active": "Active members per sport",
  "lam.disability": "Active members with a disability per sport",
  "lam.allidrett": "Members in all-round sport",
  "lam.target": "LAM's target groups (children 6–12, youth 13–19)",
  "lam.counted": "Counted as a member",
  "lam.active_counted": "Counted as active",
  "lam.not_member": "Not a member on 31 December",
  "lam.fee_unpaid": "The fee is not paid: not counted",
  "lam.fee_unknown": "The club does not keep fees in ClubAdmin: check the payment",
  "lam.no_birth_date": "Birth date missing",
  "lam.pdf.deadline": "Deadline in coordinated reporting",
  "lam.pdf.source":
    "Figures on 31 December for coordinated reporting in KlubbAdmin. The sports councils distribute LAM by member or activity figures.",
};

export const TEXTS = { sv, en, nb };
