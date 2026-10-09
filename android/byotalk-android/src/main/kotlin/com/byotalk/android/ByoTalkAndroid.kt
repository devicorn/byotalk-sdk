// Android glue: SharedPreferences persistence and reconnect on app foreground / network back.
package com.byotalk.android

import android.app.Activity
import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Bundle
import com.byotalk.ByoTalkChat
import com.byotalk.PersistenceAdapter

/** Unsent messages and the sync cursor survive app restarts. */
class SharedPreferencesPersistence(context: Context, name: String = "byotalk") : PersistenceAdapter {
    private val prefs = context.applicationContext.getSharedPreferences(name, Context.MODE_PRIVATE)
    override suspend fun get(key: String): String? = prefs.getString(key, null)
    override suspend fun set(key: String, value: String) = prefs.edit().putString(key, value).apply()
    override suspend fun delete(key: String) = prefs.edit().remove(key).apply()
}

/**
 * Calls [ByoTalkChat.reconnectNow] when the app returns to the foreground or the network comes back.
 * Returns a function that removes the listeners.
 */
fun ByoTalkChat.attachLifecycle(app: Application): () -> Unit {
    var started = 0
    val activities = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) {
            if (started++ == 0) reconnectNow()
        }
        override fun onActivityStopped(activity: Activity) {
            started--
        }
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    }
    val network = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = reconnectNow()
    }
    val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    app.registerActivityLifecycleCallbacks(activities)
    cm.registerDefaultNetworkCallback(network)
    return {
        app.unregisterActivityLifecycleCallbacks(activities)
        cm.unregisterNetworkCallback(network)
    }
}
