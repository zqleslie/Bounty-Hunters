<?php

namespace Database\Seeders;

use App\Models\NotificationPreference;
use Illuminate\Database\Seeder;

class NotificationPreferenceSeeder extends Seeder
{
    public function run(): void
    {
        $users = \App\Models\User::all();
        foreach ($users as $user) {
            $defaults = NotificationPreference::defaults();
            foreach ($defaults as $default) {
                NotificationPreference::updateOrCreate(
                    ['user_id' => $user->id, 'channel' => $default['channel'], 'event_type' => $default['event_type']],
                    ['enabled' => $default['enabled']]
                );
            }
        }
    }
}
