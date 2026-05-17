<?php

namespace App\Http\Controllers;

use App\Models\NotificationPreference;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Validator;

class NotificationPreferenceController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $userId = $request->user()?->id;
        if (!$userId) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $preferences = NotificationPreference::where('user_id', $userId)->get();
        return response()->json($preferences);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $userId = $request->user()?->id;
        if (!$userId) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $preference = NotificationPreference::where('user_id', $userId)->findOrFail($id);

        $validator = Validator::make($request->all(), [
            'enabled' => 'required|boolean',
        ]);

        if ($validator->fails()) {
            return response()->json(['errors' => $validator->errors()], 422);
        }

        $preference->update(['enabled' => $request->boolean('enabled')]);
        return response()->json($preference);
    }

    public function bulkUpdate(Request $request): JsonResponse
    {
        $userId = $request->user()?->id;
        if (!$userId) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $validator = Validator::make($request->all(), [
            'preferences' => 'required|array',
            'preferences.*.id' => 'required|integer',
            'preferences.*.enabled' => 'required|boolean',
        ]);

        if ($validator->fails()) {
            return response()->json(['errors' => $validator->errors()], 422);
        }

        $updated = [];
        foreach ($request->input('preferences') as $pref) {
            $preference = NotificationPreference::where('user_id', $userId)->find($pref['id']);
            if ($preference) {
                $preference->update(['enabled' => (bool) $pref['enabled']]);
                $updated[] = $preference;
            }
        }

        return response()->json($updated);
    }
}
