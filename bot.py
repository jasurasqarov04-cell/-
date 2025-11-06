import telebot
from telebot import types
import os
import logging
from flask import Flask, request # Нужно для работы Webhook

# Настройка логирования для отладки
logger = telebot.logger
telebot.logger.setLevel(logging.INFO)

# ----------------- КОНФИГУРАЦИЯ -----------------
# 1. Токен берется из переменной окружения (Scalingo)
TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN') 
if not TOKEN:
    raise ValueError("TELEGRAM_BOT_TOKEN не установлен в переменных окружения.")

bot = telebot.TeleBot(TOKEN)

# 2. Ваши данные для отправки:
DESCRIPTION_TEXT = """
*Название компании: RebarUzbekistan*
Мы являемся ведущим поставщиком базальто-композитной арматуры в Узбекистане. 
Наши преимущества: прочность, легкость и долговечность.
"""

# Изображение: Используйте прямую ссылку на изображение или его File ID
IMAGE_URL = 'https://example.com/images/your_product_promo.jpg' 

# Видео: Используйте прямую ссылку на видео или его File ID
VIDEO_URL = 'https://example.com/videos/your_promo_video.mp4'

# Webhook-конфигурация
SERVER_URL = os.environ.get("SCALINGO_URL", "https://your-app-name.scalingo.io") # Scalingo сам предоставит URL
WEBHOOK_PATH = f"/bot/{TOKEN}" # Секретный путь для Webhook
APP_PORT = os.environ.get('PORT', 8080) # Порт, который слушает Scalingo

# ----------------- ФУНКЦИИ КЛАВИАТУРЫ И ОБРАБОТЧИКИ (Остаются прежними) -----------------

def create_main_keyboard():
    # Создаем Reply-клавиатуру (кнопки под полем ввода)
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True, row_width=2)
    btn1 = types.KeyboardButton("📄 Описание")
    btn2 = types.KeyboardButton("🖼 Изображение")
    btn3 = types.KeyboardButton("📹 Видео")
    markup.add(btn1, btn2, btn3)
    return markup

@bot.message_handler(commands=['start'])
def send_welcome(message):
    chat_id = message.chat.id
    keyboard = create_main_keyboard()
    bot.send_message(
        chat_id,
        "Здравствуйте! Выберите интересующий вас контент:",
        reply_markup=keyboard
    )

@bot.message_handler(func=lambda message: message.text == "📄 Описание")
def send_description(message):
    bot.send_message(
        message.chat.id,
        DESCRIPTION_TEXT,
        parse_mode='Markdown'
    )

@bot.message_handler(func=lambda message: message.text == "🖼 Изображение")
def send_photo(message):
    try:
        bot.send_photo(
            message.chat.id, 
            IMAGE_URL, 
            caption="Наше высококачественное сырье."
        )
    except Exception as e:
        bot.send_message(message.chat.id, f"Ошибка: проверьте ссылку. ({e})")

@bot.message_handler(func=lambda message: message.text == "📹 Видео")
def send_video(message):
    try:
        bot.send_video(
            message.chat.id, 
            VIDEO_URL, 
            caption="Промо-ролик о нашей продукции."
        )
    except Exception as e:
        bot.send_message(message.chat.id, f"Ошибка: проверьте ссылку. ({e})")

# ----------------- ЗАПУСК БОТА (Webhooks) -----------------

# Создаем Flask-приложение для приема Webhook-запросов
app = Flask(__name__)

@app.route(WEBHOOK_PATH, methods=['POST'])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        json_string = request.get_data().decode('utf-8')
        update = telebot.types.Update.de_json(json_string)
        bot.process_new_updates([update])
        return '!', 200
    else:
        return '', 403

if __name__ == '__main__':
    # Устанавливаем Webhook при запуске
    bot.remove_webhook()
    
    # URL, на который Telegram будет отправлять сообщения
    webhook_url = f"https://{SERVER_URL}{WEBHOOK_PATH}" 
    bot.set_webhook(url=webhook_url)
    
    logger.info(f"Webhook установлен: {webhook_url}")
    
    # Запускаем Flask-приложение
    # В реальном Scalingo он будет запущен через gunicorn, но для локального теста подойдет
    app.run(host="0.0.0.0", port=APP_PORT)
