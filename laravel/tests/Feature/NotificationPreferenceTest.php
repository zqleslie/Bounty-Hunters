<?php

namespace Tests\Feature;

use App\Models\NotificationPreference;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class NotificationPreferenceTest extends TestCase
{
    use RefreshDatabase;

    public function test_user_can_view_notification_preferences(): void
    {
        $user = User::factory()->create();
        NotificationPreference::factory()->create(['user_id' => $user->id]);

        $response = $this->actingAs($user)->getJson('/api/notifications/preferences');
        $response->assertOk()->assertJsonCount(1);
    }

    public function test_unauthenticated_cannot_view(): void
    {
        $this->getJson('/api/notifications/preferences')->assertStatus(401);
    }

    public function test_user_can_update_preference(): void
    {
        $user = User::factory()->create();
        $pref = NotificationPreference::factory()->create(['user_id' => $user->id, 'enabled' => true]);

        $response = $this->actingAs($user)->putJson("/api/notifications/preferences/{$pref->id}", ['enabled' => false]);
        $response->assertOk()->assertJsonPath('enabled', false);
        $this->assertFalse($pref->fresh()->enabled);
    }

    public function test_user_can_bulk_update(): void
    {
        $user = User::factory()->create();
        $p1 = NotificationPreference::factory()->create(['user_id' => $user->id, 'enabled' => true]);
        $p2 = NotificationPreference::factory()->create(['user_id' => $user->id, 'enabled' => true]);

        $response = $this->actingAs($user)->postJson('/api/notifications/preferences/bulk', [
            'preferences' => [['id' => $p1->id, 'enabled' => false], ['id' => $p2->id, 'enabled' => false]]
        ]);
        $response->assertOk()->assertJsonCount(2);
    }

    public function test_cannot_update_others_preferences(): void
    {
        $u1 = User::factory()->create();
        $u2 = User::factory()->create();
        $pref = NotificationPreference::factory()->create(['user_id' => $u1->id]);

        $this->actingAs($u2)->putJson("/api/notifications/preferences/{$pref->id}", ['enabled' => false])
            ->assertNotFound();
    }

    public function test_new_user_gets_defaults(): void
    {
        $user = User::factory()->create();
        $count = NotificationPreference::where('user_id', $user->id)->count();
        $this->assertEquals(15, $count);
    }
}
