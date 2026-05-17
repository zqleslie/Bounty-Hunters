<?php

namespace App\Observers;

use App\Models\User;
use App\Models\NotificationPreference;

class UserObserver
{
    public function created(User $user): void
    {
        $defaults = NotificationPreference::defaults();
        foreach ($defaults as $default) {
            NotificationPreference::create([
                'user_id' => $user->id,
                'channel' => $default['channel'],
                'event_type' => $default['event_type'],
                'enabled' => $default['enabled'],
            ]);
        }
    }
}
