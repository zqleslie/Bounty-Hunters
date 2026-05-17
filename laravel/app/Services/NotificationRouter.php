<?php

namespace App\Services;

use App\Models\NotificationPreference;
use App\Models\User;

class NotificationRouter
{
    public function getEnabledChannels(User $user, string $eventType): array
    {
        return NotificationPreference::where('user_id', $user->id)
            ->where('event_type', $eventType)
            ->where('enabled', true)
            ->pluck('channel')
            ->toArray();
    }

    public function shouldNotify(User $user, string $eventType, string $channel): bool
    {
        return NotificationPreference::where('user_id', $user->id)
            ->where('event_type', $eventType)
            ->where('channel', $channel)
            ->where('enabled', true)
            ->exists();
    }

    public function dispatch(User $user, string $eventType, object $notification): void
    {
        $channels = $this->getEnabledChannels($user, $eventType);

        foreach ($channels as $channel) {
            match ($channel) {
                'mail' => $user->notify($notification),
                'slack' => $user->routeNotificationFor('slack', $notification),
                'database' => $user->notifications()->create([
                    'type' => get_class($notification),
                    'data' => $notification->toArray(),
                ]),
                default => null,
            };
        }
    }
}
