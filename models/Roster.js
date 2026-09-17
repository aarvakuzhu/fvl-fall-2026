const mongoose = require('mongoose');

/**
 * The roster — captains and players, each with name/number/tier/pic/skills
 * — used to be hardcoded in public/index.html. It now lives here instead,
 * so it can be updated anytime (reseed from an updated spreadsheet, or a
 * direct edit via PUT /api/roster) without touching app code or
 * redeploying. One document per rosterId, so a future season can coexist
 * (e.g. "fall-2026", "spring-2027") without overwriting this one.
 */
const PersonSchema = new mongoose.Schema(
  {
    name:    { type: String, required: true },
    number:  { type: String, default: '' },  // contact number, e.g. WhatsApp
    tier:    { type: String, required: true }, // Biryani / Samosa / Chai / Biscuit / Gatorade
    pic:     { type: String, default: '' },
    skills:  { type: String, default: '' },   // primary skill — added after the initial import
    remarks: { type: String, default: '' },
  },
  { _id: false }
);

const RosterSchema = new mongoose.Schema(
  {
    rosterId: { type: String, required: true, unique: true, index: true },
    captains: { type: [PersonSchema], default: [] },
    players:  { type: [PersonSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Roster', RosterSchema);
