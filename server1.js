const { initializeApp } = require('firebase/app');
const { getDatabase, ref, runTransaction, update } = require('firebase/database');
const venom = require('venom-bot');

// הגדרות Firebase
const firebaseConfig = {
    apiKey: "AIzaSyB8LTCh_O_C0mFYINpbdEqgiW_3Z51L1ag",
    authDomain: "final-project-d6ce7.firebaseapp.com",
    projectId: "final-project-d6ce7",
    storageBucket: "final-project-d6ce7.appspot.com",
    messagingSenderId: "1056060530572",
    appId: "1:1056060530572:web:d08d859ca2d25c46d340a9",
    measurementId: "G-LD61QH3VVP"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

const SERVER_ID = 'server1'; // מזהה ייחודי לשרת הזה
const MAX_MESSAGES_PER_DAY = 30; // המכסה היומית
let sentCount = 0; // מספר ההודעות שנשלחו היום

// אתחול Venom Bot
let clientInstance = null;

venom
  .create({
    session: SERVER_ID,
    multidevice: true,
  })
  .then((client) => {
    console.log(`✅ ${SERVER_ID} מחובר ל-Venom Bot`);
    clientInstance = client;
    resetDailyQuota();
    processMessages();
    listenForMessages(client); // מאזין להודעות נכנסות
  })
  .catch((error) => {
    console.error(`❌ שגיאה ב-${SERVER_ID}:`, error);
  });

// איפוס המכסה היומית אם עבר יום חדש
async function resetDailyQuota() {
  const serverRef = ref(db, `servers/${SERVER_ID}`);
  const today = new Date().toISOString().split('T')[0];

  await runTransaction(serverRef, (serverData) => {
    if (!serverData || serverData.lastReset !== today) {
      console.log(`🔄 מאפס מכסה יומית עבור ${SERVER_ID}`);
      return {
        sentCount: 0,
        lastReset: today,
      };
    }
    return serverData;
  });
}

// שליחת הודעות
async function processMessages() {
    setInterval(async () => {
      if (sentCount >= MAX_MESSAGES_PER_DAY) {
        console.log(`🚫 ${SERVER_ID} הגיע למכסה היומית (${MAX_MESSAGES_PER_DAY}).`);
        return;
      }

      const message = await claimMessage();
      if (message) {
        try {
          console.log(`📨 ${SERVER_ID} שולח הודעה למספר ${message.formattedContacts}`);

          await clientInstance.sendImage(
            `${message.formattedContacts}@c.us`,
            message.imageUrl,
            'image',
            message.message
          );

          await updateMessageStatus(message.id, 'sent');
          await incrementSentCount();
          sentCount++;

          console.log(`✅ ${SERVER_ID} שלח הודעה למספר ${message.formattedContacts}`);
        } catch (error) {
          console.error(`❌ ${SERVER_ID} נכשל בשליחת ההודעה:`, error.message);
          await updateMessageStatus(message.id, 'error', error.message);
        }
      } else {
        console.log(`🚫 אין הודעות ממתינות עבור ${SERVER_ID}.`);
      }
    }, 10000);
}

// מאזין להודעות נכנסות
function listenForMessages(client) {
    client.onMessage(async (message) => {
      if (message.isGroupMsg === false) { // מתעלם מהודעות קבוצתיות
        console.log(`📥 הודעה נכנסת מ-${message.from}: ${message.body}`);
  
        const formattedContact = message.from.replace('@c.us', '');
        const newMessage = {
          message: message.body,
          timestamp: Date.now(),
          status: 'received',
          serverId: SERVER_ID
        };
  
        // מנגנון נעילה - ניסיון לנעול את ההודעה ב-Firebase
        const messageRef = ref(db, `whatsapp/${formattedContact}/message_in`);
        let locked = false;
  
        await runTransaction(messageRef, (data) => {
          if (!data) {
            data = {}; // יצירת עץ חדש אם לא קיים
          }
  
          const lockKey = `lock_${SERVER_ID}`;
          if (!data.lock) {
            data.lock = lockKey; // נועל את ההודעה לשרת הנוכחי
            locked = true;
          } else if (data.lock === lockKey) {
            locked = true; // אם כבר נעול על ידי השרת הנוכחי
          } else {
            locked = false; // כבר נעול לשרת אחר
          }
          return data;
        });
  
        if (locked) {
          console.log(`🔒 ההודעה נעולה על ידי ${SERVER_ID}.`);
  
          // הוספת ההודעה ל-message_in
          const messageId = `msg_${Date.now()}`;
          await update(messageRef, {
            [`messages/${messageId}`]: newMessage
          });
  
          console.log(`✅ הודעה נכנסת נשמרה ב-Firebase תחת message_in.`);
        } else {
          console.log(`🚫 ההודעה כבר בטיפול על ידי שרת אחר.`);
        }
      }
    });
  }
  

// נעילת הודעה (Claim)
async function claimMessage() {
  const whatsappRef = ref(db, 'whatsapp');
  let claimedMessage = null;

  await runTransaction(whatsappRef, (messages) => {
    if (messages) {
      for (const [userId, userMessages] of Object.entries(messages)) {
        for (const [key, message] of Object.entries(userMessages)) {
          if (message.status === 'pending') {
            claimedMessage = { id: `${userId}/${key}`, ...message };
            userMessages[key].status = 'sending';
            userMessages[key].serverId = SERVER_ID;
            break;
          }
        }
        if (claimedMessage) break;
      }
    }
    return messages;
  });

  return claimedMessage;
}

async function incrementSentCount() {
  const serverRef = ref(db, `servers/${SERVER_ID}/sentCount`);
  await runTransaction(serverRef, (currentValue) => (currentValue || 0) + 1);
  console.log(`✅ מספר ההודעות שנשלחו על ידי ${SERVER_ID} עודכן.`);
}

// עדכון סטטוס הודעה
async function updateMessageStatus(messageId, status, error = null) {
  const messageRef = ref(db, `whatsapp/${messageId}`);
  const updateData = { status };
  if (error) {
    updateData.error = error;
  }
  await update(messageRef, updateData);
  console.log(`✅ סטטוס ההודעה ${messageId} עודכן ל-${status}`);
}
