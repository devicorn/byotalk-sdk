import Foundation

public enum ConnectionState: String, Sendable {
    case disconnected, connecting, syncing, connected, reconnecting, failed
}

public struct Attachment: Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let size: Int
    public let mimeType: String
    public let width: Int?
    public let height: Int?
}

public struct Message: Decodable, Sendable, Equatable {
    public enum Status: String, Sendable { case sending, sent, failed }

    /// nil while sending
    public var id: String?
    /// own messages only
    public var clientMsgId: String?
    public var conversationId: String
    public var seq: Int?
    public var senderId: String
    public var text: String?
    public var replyTo: String?
    public var attachments: [Attachment]
    public var metadata: Json
    public var version: Int
    public var status: Status
    public var error: ChatError?
    /// server time once sent; local time while sending
    public var createdAt: Date
    public var editedAt: Date?
    public var deletedAt: Date?

    /// Stable across the ack (own messages keep their clientMsgId): use as a list identity.
    public var key: String { clientMsgId ?? id ?? "" }

    init(id: String?, clientMsgId: String?, conversationId: String, seq: Int?, senderId: String, text: String?, replyTo: String?,
         attachments: [Attachment], metadata: Json, version: Int, status: Status, createdAt: Date) {
        self.id = id
        self.clientMsgId = clientMsgId
        self.conversationId = conversationId
        self.seq = seq
        self.senderId = senderId
        self.text = text
        self.replyTo = replyTo
        self.attachments = attachments
        self.metadata = metadata
        self.version = version
        self.status = status
        self.createdAt = createdAt
    }

    private enum K: String, CodingKey {
        case id, clientMsgId, conversationId, seq, senderId, text, replyTo, attachments, metadata, version, createdAt, editedAt, deletedAt
    }

    /// Server message shape (docs/07); received messages are always `sent`.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        clientMsgId = try c.decodeIfPresent(String.self, forKey: .clientMsgId)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        seq = try c.decode(Int.self, forKey: .seq)
        senderId = try c.decode(String.self, forKey: .senderId)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        replyTo = try c.decodeIfPresent(String.self, forKey: .replyTo)
        attachments = try c.decodeIfPresent([Attachment].self, forKey: .attachments) ?? []
        metadata = try c.decodeIfPresent(Json.self, forKey: .metadata) ?? [:]
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        status = .sent
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        editedAt = try c.decodeIfPresent(Date.self, forKey: .editedAt)
        deletedAt = try c.decodeIfPresent(Date.self, forKey: .deletedAt)
    }
}

public struct Member: Decodable, Sendable, Equatable {
    public let userId: String
    public var role: String
    public var lastReadSeq: Int?
    public var lastDeliveredSeq: Int?
}

public struct ConversationSummary: Decodable, Sendable, Equatable {
    public let id: String
    public let type: String
    public var name: String?
    public var metadata: Json
    public var lastSeq: Int
    public var unreadCount: Int
    public var lastReadSeq: Int
    public var muted: Bool
    public var lastActivityAt: Date
    public var lastMessage: Message?
}

public struct Page<T: Decodable & Sendable>: Decodable, Sendable {
    public let data: [T]
    public let nextCursor: String?
}

public struct Presence: Decodable, Sendable, Equatable {
    public let userId: String
    public let online: Bool
    public let lastSeenAt: Date?
}

public struct MemberEvent: Decodable, Sendable, Equatable {
    public let userIds: [String]?
    public let userId: String?
    public let actorId: String?
    public let reason: String?
}

public struct Receipt: Sendable, Equatable {
    public let userId: String
    public let lastReadSeq: Int
    public let lastDeliveredSeq: Int
}

public enum ConversationEvent: Sendable {
    case messageNew(Message)
    case messageUpdated(Message)
    case messageDeleted(Message)
    case messageFailed(Message)
    /// Everyone typing now.
    case typing([String])
    case receipt(Receipt)
    case memberAdded(MemberEvent)
    case memberRemoved(MemberEvent)
    /// Name or metadata changed.
    case updated
    /// You left or were removed.
    case removed
}

struct ServerConversation: Decodable {
    let id: String
    let type: String
    let name: String?
    let metadata: Json?
    let lastSeq: Int
    let members: [Member]?
    let lastReadSeq: Int?
    let muted: Bool?
}
