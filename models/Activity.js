const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  // 1. Relational Link
  deviceId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Device', 
    required: true,
    index: true 
  },

  // 2. Core Tracking Data
  activityId: { type: String, required: true, unique: true },
  activeWindow: { type: String },
  browserUrl: { type: String, default: "" }, // <-- NEW: Stores the extracted Chrome/Edge URL
  username: { type: String },                // <-- NEW: The Windows OS Username
  idleSeconds: { type: Number },
  status: { type: String, enum: ['active', 'idle'], default: 'active' },
  
  // 3. Network & Hardware Telemetry
  localIp: { type: String },
  macAddress: { type: String },
  ramUsagePct: { type: Number },
  cpuCores: { type: Number },
  batteryPct: { type: Number },
  isPluggedIn: { type: Boolean },
  freeDiskSpaceGB: { type: Number },

  // 4. Media & Cloud Storage
  screenshotUrl: { type: String, required: true },
  
  // 5. Indexed Timestamp
  timestamp: { 
    type: Date, 
    required: true, 
    index: true 
  }
}, { 
  timestamps: true 
});

module.exports = mongoose.model('Activity', activitySchema);