package dev.pitbox.connect

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri

/** Runs before `Application.onCreate`: the saved dev server is in place before the bundle is requested. */
class PitboxConnectProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    val context = context ?: return false
    if (PitboxConnect.isDebuggable(context)) PitboxConnect.apply(context)
    return true
  }

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
