const mongoose = require('mongoose');

const urlEntrySchema = new mongoose.Schema({
  url: { type: String, required: true, lowercase: true, trim: true },
  domain: { type: String, index: true },
  pageTitle: String,
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  visitCount: { type: Number, default: 1 },
  timeSpentSec: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'idle'], default: 'active' }
}, { _id: false });

const appEntrySchema = new mongoose.Schema({
  appName: { type: String, required: true, index: true },
  windowTitle: String,
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  timeSpentSec: { type: Number, default: 0 }
}, { _id: false });

const userActivitySummarySchema = new mongoose.Schema({
  deviceId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Device', 
    required: true, 
    index: true 
  },
  username: { type: String, required: true, index: true },
  machineName: { type: String, index: true },
  
  date: { 
    type: Date, 
    required: true, 
    default: () => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }
  },

  urls: [urlEntrySchema],
  applications: [appEntrySchema],
  
  stats: {
    totalScreenshots: { type: Number, default: 0 },
    totalActiveSec: { type: Number, default: 0 },
    totalIdleSec: { type: Number, default: 0 },
    uniqueUrlCount: { type: Number, default: 0 },
    uniqueAppCount: { type: Number, default: 0 }
  },
  
  lastUpdated: { type: Date, default: Date.now }
}, { 
  timestamps: true,
  indexes: [
    { fields: { deviceId: 1, date: -1 }, unique: true },
    { fields: { username: 1, date: -1 } }
  ]
});

// Helper: Extract domain
userActivitySummarySchema.statics.extractDomain = function(url) {
  try {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return 'other';
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return 'other';
  }
};

// Helper: Upsert URL
userActivitySummarySchema.methods.upsertUrl = function(urlData, timeSec = 1) {
  const domain = this.constructor.extractDomain(urlData.url);
  const existing = this.urls.find(u => u.url === urlData.url.toLowerCase());
  
  if (existing) {
    existing.visitCount += 1;
    existing.timeSpentSec += timeSec;
    existing.lastSeen = new Date(Math.max(new Date(existing.lastSeen), new Date(urlData.timestamp)));
    if (urlData.pageTitle) existing.pageTitle = urlData.pageTitle;
  } else {
    this.urls.push({
      url: urlData.url.toLowerCase(),
      domain,
      pageTitle: urlData.pageTitle || '',
      firstSeen: new Date(urlData.timestamp),
      lastSeen: new Date(urlData.timestamp),
      visitCount: 1,
      timeSpentSec: timeSec,
      status: urlData.status
    });
  }
  this.stats.uniqueUrlCount = this.urls.length;
};

// Helper: Upsert App
userActivitySummarySchema.methods.upsertApp = function(appData, timeSec = 1) {
  const existing = this.applications.find(a => a.appName === appData.appName);
  
  if (existing) {
    existing.timeSpentSec += timeSec;
    existing.lastSeen = new Date(Math.max(new Date(existing.lastSeen), new Date(appData.timestamp)));
    if (appData.windowTitle) existing.windowTitle = appData.windowTitle;
  } else {
    this.applications.push({
      appName: appData.appName,
      windowTitle: appData.windowTitle || '',
      firstSeen: new Date(appData.timestamp),
      lastSeen: new Date(appData.timestamp),
      timeSpentSec: timeSec
    });
  }
  this.stats.uniqueAppCount = this.applications.length;
};

module.exports = mongoose.model('UserActivitySummary', userActivitySummarySchema);