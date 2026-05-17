# Phase 1: Research - Notification Preferences System

## Task
Issue #793: [Laravel] Implement user notification preferences with channel routing

## Architecture
- Bare Laravel 12+ skeleton (PHP 8.2+ attributes)
- Only web.php root route, no API routes
- Single User model with Notifiable trait
- No existing migrations, controllers, or services

## Related Files
| File | Purpose | Action |
|------|---------|--------|
| app/Models/NotificationPreference.php | New model | CREATE |
| app/Http/Controllers/NotificationPreferenceController.php | REST controller | CREATE |
| app/Services/NotificationRouter.php | Preference check service | CREATE |
| app/Observers/UserObserver.php | Seed defaults on user create | CREATE |
| app/Providers/AppServiceProvider.php | Register Observer | MODIFY |
| routes/api.php | API routes | CREATE |
| database/migrations/*_create_notification_preferences_table.php | DB schema | CREATE |
| database/seeders/NotificationPreferenceSeeder.php | Default preferences | CREATE |
| tests/Feature/NotificationPreferenceTest.php | Feature tests | CREATE |

## Conventions
- PHP 8.2+ attributes: #[Fillable], #[Hidden]
- casts() method for type casting
- Laravel 12 style: no Kernel.php
- Namespaces: App\Models, App\Http\Controllers, App\Services

## Risks
1. No migrations exist yet, need to create from scratch
2. No auth middleware configured
3. Laravel 11+ requires manual Observer registration in AppServiceProvider
