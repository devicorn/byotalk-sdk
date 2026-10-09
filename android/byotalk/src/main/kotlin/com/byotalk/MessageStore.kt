// Message window per conversation: confirmed messages ordered by seq, pending sends after them in local
// order; at most 500 messages kept (docs/09-SDK-DESIGN.md §4.3). Not thread-safe: the chat loop owns it.
package com.byotalk

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

private const val WINDOW = 500

private val ORDER = Comparator<Message> { a, b ->
    when {
        a.seq != null && b.seq != null -> a.seq.compareTo(b.seq)
        a.seq != null -> -1
        b.seq != null -> 1
        else -> a.createdAt.compareTo(b.createdAt)
    }
}

class MessageStore {
    private var list = mutableListOf<Message>()
    private val _items = MutableStateFlow<List<Message>>(emptyList())

    /** Immutable snapshot after every change (Compose/LiveData friendly). */
    val items: StateFlow<List<Message>> = _items

    private fun changed() {
        _items.value = list.toList()
    }

    private fun sort() {
        list.sortWith(ORDER)
        if (list.size > WINDOW) list = list.subList(list.size - WINDOW, list.size).toMutableList()
    }

    fun get(id: String) = list.find { it.id == id }

    fun getByClientId(clientMsgId: String) = list.find { it.clientMsgId == clientMsgId }

    /** Inserts or replaces a confirmed message; an older version never replaces a newer one. */
    fun upsert(m: Message) = upsertMany(listOf(m))

    fun upsertMany(ms: List<Message>) {
        for (m in ms) {
            val i = list.indexOfFirst { it.id != null && it.id == m.id }
            if (i < 0) list.add(m)
            else if (list[i].version <= m.version) list[i] = m.copy(clientMsgId = list[i].clientMsgId ?: m.clientMsgId)
        }
        sort()
        changed()
    }

    fun addPending(m: Message) {
        list.add(m)
        sort()
        changed()
    }

    /** Ack: the pending message gets its id/seq/server time and moves to its seq position. */
    fun reconcile(clientMsgId: String, id: String, seq: Long, createdAt: String) {
        val i = list.indexOfFirst { it.clientMsgId == clientMsgId && it.id == null }
        if (i < 0) return
        val dupe = list.indexOfFirst { it.id == id }
        if (dupe >= 0) {
            // The live event arrived before the ack: keep the confirmed copy, mark it as ours.
            list[dupe] = list[dupe].copy(clientMsgId = clientMsgId)
            list.removeAt(i)
        } else {
            list[i] = list[i].copy(id = id, seq = seq, createdAt = createdAt, status = MessageStatus.SENT, error = null)
        }
        sort()
        changed()
    }

    fun markFailed(clientMsgId: String, error: ChatException) = setPendingStatus(clientMsgId, MessageStatus.FAILED, error)

    fun markSending(clientMsgId: String) = setPendingStatus(clientMsgId, MessageStatus.SENDING, null)

    private fun setPendingStatus(clientMsgId: String, status: MessageStatus, error: ChatException?) {
        val i = list.indexOfFirst { it.clientMsgId == clientMsgId && it.id == null }
        if (i < 0) return
        list[i] = list[i].copy(status = status, error = error)
        changed()
    }

    /** Optimistic edit/delete: returns an undo function. */
    fun patch(id: String, p: (Message) -> Message): (() -> Unit)? {
        val i = list.indexOfFirst { it.id == id }
        if (i < 0) return null
        val before = list[i]
        list[i] = p(before)
        changed()
        return {
            val j = list.indexOfFirst { it.id == id }
            if (j >= 0) {
                list[j] = before
                changed()
            }
        }
    }

    /** Drops the window but keeps unsent messages. */
    fun clear() {
        list = list.filter { it.id == null }.toMutableList()
        changed()
    }

    val oldestSeq: Long? get() = list.firstOrNull { it.seq != null }?.seq
}
