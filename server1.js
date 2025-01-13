const { initializeApp } = require('firebase/app');
const { getDatabase, ref,get, runTransaction, update } = require('firebase/database');
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

  function formatPhoneNumber(phoneNumber) {
    // הסרת כל תווים שאינם ספרות
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
  
    // אם המספר מתחיל ב-0, מחליף את הקידומת ל-972
    if (phoneNumber.startsWith('0')) {
      phoneNumber = `972${phoneNumber.slice(1)}`;
    }
  
    return phoneNumber; // מחזיר את המספר בפורמט אחיד ללא סימן '+'
  }
  

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
    if (!message.isGroupMsg) { // מתעלם מהודעות קבוצתיות
      console.log(`📥 הודעה נכנסת מ-${message.from}: ${message.body}`);

      const formattedContact = formatPhoneNumber(message.from.replace('@c.us', ''));
      const whatsappRef = ref(db, 'whatsapp');

      try {
        const snapshot = await get(whatsappRef);
        if (!snapshot.exists()) {
          console.log(`🚫 אין הודעות שנשלחו למספר ${formattedContact}.`);
          return;
        }

        const data = snapshot.val();
        let matchedMessagePath = null; // הנתיב להודעה התואמת
        let latestTimestamp = null; // זמן ההודעה האחרונה שנשלחה

        // חיפוש הודעה תואמת
        for (const [userId, userEvents] of Object.entries(data)) {
          for (const [eventId, messages] of Object.entries(userEvents)) {
            for (const [msgId, msgData] of Object.entries(messages)) {
              if (
                msgData.formattedContacts === formattedContact && // התאמה לפי מספר הטלפון
                msgData.status === 'sent' &&                     // רק הודעות שנשלחו
                (!latestTimestamp || new Date(msgData.timestamp) > latestTimestamp) // ההודעה האחרונה
              ) {
                matchedMessagePath = `whatsapp/${userId}/${eventId}/${msgId}`;
                latestTimestamp = new Date(msgData.timestamp);
              }
            }
          }
        }

        if (matchedMessagePath) {
          // עדכון ההודעה עם התשובה שהתקבלה
          const receivedMessageId = `msg_${Date.now()}`; // מזהה ייחודי לתשובה
          const updateData = {
            [`receivedMessages/${receivedMessageId}`]: message.body,
          };

          // שמירת התשובה ב-Firebase
          await update(ref(db, matchedMessagePath), updateData);

          console.log(`✅ התשובה נשמרה תחת ${matchedMessagePath}`);
        } else {
          console.log(`🚫 לא נמצאה הודעה תואמת למספר ${formattedContact}.`);
        }
      } catch (error) {
        console.error(`❌ שגיאה בטיפול בהודעה נכנסת:`, error.message);
      }
    }
  });
}




async function saveMessageToFirebase(userId, eventId, messageId, messageData) {
  const messageRef = ref(db, `whatsapp/${userId}/${eventId}/${messageId}`);
  await update(messageRef, {
    ...messageData,
    currentUserUid: userId, // מזהה המשתמש
    eventUserId: eventId,  // מזהה האירוע
  });
  console.log(`✅ הודעה נשמרה ב-Firebase: ${messageId}`);
}



  

// נעילת הודעה (Claim)
async function claimMessage() {
  const whatsappRef = ref(db, 'whatsapp');
  let claimedMessage = null;

  await runTransaction(whatsappRef, (users) => {
    if (users) {
      for (const [userId, events] of Object.entries(users)) {
        for (const [eventId, messages] of Object.entries(events)) {
          for (const [messageId, messageData] of Object.entries(messages)) {
            if (messageData.status === 'pending') {
              claimedMessage = {
                id: `${userId}/${eventId}/${messageId}`,
                ...messageData,
                currentUserUid: userId,
                eventUserId: eventId,
              };
              messageData.status = 'sending'; // עדכון סטטוס
              messageData.serverId = SERVER_ID; // שמירת מזהה השרת
              break;
            }
          }
          if (claimedMessage) break;
        }
        if (claimedMessage) break;
      }
    }
    return users;
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
  const [userId, eventId, msgId] = messageId.split('/');
  const messageRef = ref(db, `whatsapp/${userId}/${eventId}/${msgId}`);
  const updateData = { status };

  if (error) {
    updateData.error = error;
  }

  await update(messageRef, updateData);
  console.log(`✅ סטטוס ההודעה ${messageId} עודכן ל-${status}`);
}


