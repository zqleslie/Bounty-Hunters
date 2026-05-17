# Phase 2: Plan - Notification Preferences Implementation

## Implementation

### 1. Migration: database/migrations/2026_05_17_000001_create_notification_preferences_table.php
- Fields: id, user_id FK, channel (string), event_type (string), enabled (boolean), timestamps
- Unique constraint on user_id+channel+event_type

### 2. Model: app/Models/NotificationPreference.php
- Fillable: user_id, channel, event_type, enabled
- casts: enabled -> boolean
- Relation: belongsTo User
- Static defaults(): 3 channels x 5 events = 15 default preferences

### 3. Controller: app/Http/Controllers/NotificationPreferenceController.php
- index: GET /notifications/preferences - list user's preferences
- update: PUT /notifications/preferences/{id} - toggle single preference
- bulkUpdate: POST /notifications/preferences/bulk - bulk toggle

### 4. Service: app/Services/NotificationRouter.php
- getEnabledChannels(user, eventType) - returns enabled channel list
- shouldNotify(user, eventType, channel) - boolean check
- dispatch(user, eventType, notification) - route to enabled channels

### 5. Observer: app/Observers/UserObserver.php
- On User created: seed 15 default preferences

### 6. Routes: routes/api.php
- auth:sanctum middleware
- GET/PUT/POST endpoints

### 7. Tests: tests/Feature/NotificationPreferenceTest.php
- View preferences, update, bulk update, cross-user isolation, defaults
