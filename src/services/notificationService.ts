import twilio from 'twilio'
import { randomUUID } from 'crypto'
import { Expo } from 'expo-server-sdk'
import { query, queryOne, uuidParam } from '../db'
import { logger } from '../logger'
import { notificationQueue } from './queueService'

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
const expo = new Expo({ useFcmV1: false })

async function sendExpoNotification(
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  if (!Expo.isExpoPushToken(token)) return
  try {
    const [ticket] = await expo.sendPushNotificationsAsync([{ to: token, title, body, data }])
    if ('details' in ticket) logger.warn({ ticket }, 'Expo push failed')
  } catch (err) {
    logger.error({ err }, 'Expo push error')
  }
}

async function saveInAppNotification(userId: string, title: string, body: string): Promise<void> {
  await query(
    `INSERT INTO dbo.notifications (id, user_id, title, body, [read], created_at)
     VALUES (@id, @uid, @title, @body, 0, SYSDATETIMEOFFSET())`,
    { id: uuidParam(randomUUID()), uid: uuidParam(userId), title, body }
  )
}

export function notifyAdminOrderPlaced(order: {
  id: string
  total_amount: number
  order_items?: unknown[]
}): void {
  notificationQueue.enqueue(async () => {
    try {
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM!,
        to: process.env.ADMIN_WHATSAPP_TO!,
        body: `🛍️ New Order!\nID: #${order.id.slice(0, 8)}\nAmount: ₹${order.total_amount}\nItems: ${order.order_items?.length ?? 0}`,
      })
    } catch (err) {
      logger.error({ err }, 'WhatsApp notification failed')
    }

    const admin = await queryOne<{ fcm_token: string | null }>(
      "SELECT TOP 1 fcm_token FROM dbo.profiles WHERE role = 'admin' AND fcm_token IS NOT NULL"
    )
    if (admin?.fcm_token) {
      await sendExpoNotification(
        admin.fcm_token,
        '🛍️ New Order!',
        `Order #${order.id.slice(0, 8)} — ₹${order.total_amount}`,
        { orderId: order.id, screen: 'OrderDetail' }
      )
    }
  })
}

export function notifyCustomerStatusUpdate(userId: string, orderId: string, status: string): void {
  notificationQueue.enqueue(async () => {
    const title = 'Order Update'
    const body = `Your order #${orderId.slice(0, 8)} is now ${status.toUpperCase()}`

    await saveInAppNotification(userId, title, body)

    const profile = await queryOne<{ fcm_token: string | null }>(
      'SELECT fcm_token FROM dbo.profiles WHERE id = @id',
      { id: uuidParam(userId) }
    )
    if (profile?.fcm_token) {
      await sendExpoNotification(profile.fcm_token, title, body, { orderId, screen: 'OrderTracking' })
    }
  })
}

export function notifyEmployeeApproval(userId: string, approved: boolean): void {
  notificationQueue.enqueue(async () => {
    const title = approved ? '✅ Account Approved' : '❌ Account Rejected'
    const body = approved
      ? 'Your employee account has been approved. You can now log in.'
      : 'Your employee account registration was not approved.'

    await saveInAppNotification(userId, title, body)

    const profile = await queryOne<{ fcm_token: string | null }>(
      'SELECT fcm_token FROM dbo.profiles WHERE id = @id',
      { id: uuidParam(userId) }
    )
    if (profile?.fcm_token) {
      await sendExpoNotification(profile.fcm_token, title, body)
    }
  })
}
