<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[\Illuminate\Database\Eloquent\Attributes\Scope('forChannel', fn ($query, $channel) => $query->where('channel', $channel))]
#[\Illuminate\Database\Eloquent\Attributes\Scope('enabled', fn ($query) => $query->where('enabled', true))]
class NotificationPreference extends Model
{
    protected $fillable = [
        'user_id',
        'channel',
        'event_type',
        'enabled',
    ];

    protected function casts(): array
    {
        return [
            'enabled' => 'boolean',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public static function defaults(): array
    {
        $channels = ['mail', 'slack', 'database'];
        $events = ['order.created', 'order.updated', 'payment.received', 'user.invited', 'report.generated'];

        $preferences = [];
        foreach ($channels as $channel) {
            foreach ($events as $event) {
                $preferences[] = [
                    'channel' => $channel,
                    'event_type' => $event,
                    'enabled' => $channel === 'mail',
                ];
            }
        }
        return $preferences;
    }
}
