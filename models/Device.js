const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  machineName: { type: String, required: true, unique: true }, // e.g., "DESKTOP-992"
  employeeName: { type: String, default: 'Unassigned User' },  // Admin can change this
  lastActive: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Device', deviceSchema);