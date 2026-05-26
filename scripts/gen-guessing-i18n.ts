/**
 * One-off generator: inserts the `guessing` i18n namespace (suggestion-button
 * labels for AAC Guessing Mode) into every client-aac locale file.
 *
 * Keys are generated from a single ordered translation table so all 11 files
 * get an identical key structure in the same order (satisfies validate-i18n).
 * Idempotent: re-running skips files that already have a `guessing:` block.
 *
 * Usage: npx tsx scripts/gen-guessing-i18n.ts
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.resolve(__dirname, "..", "client-aac", "src", "i18n");

// Locale column order for each row below.
const LOCALES = ["en", "he", "es", "pt", "fr", "ru", "de", "ar", "zh", "yue", "ko"] as const;

// [ "cluster.value", en, he, es, pt, fr, ru, de, ar, zh, yue, ko ]
const TABLE: string[][] = [
  // ── category ──
  ["category.things", "A thing", "דבר", "Una cosa", "Uma coisa", "Une chose", "Вещь", "Ein Ding", "شيء", "一样东西", "一樣嘢", "사물"],
  ["category.actions", "Something you do", "משהו שעושים", "Algo que haces", "Algo que você faz", "Quelque chose qu'on fait", "Действие", "Etwas, das man tut", "شيء تفعله", "一个动作", "一個動作", "행동"],
  ["category.people", "A person", "מישהו", "Una persona", "Uma pessoa", "Une personne", "Человек", "Eine Person", "شخص", "一个人", "一個人", "사람"],
  ["category.places", "A place", "מקום", "Un lugar", "Um lugar", "Un endroit", "Место", "Ein Ort", "مكان", "一个地方", "一個地方", "장소"],
  ["category.feelings", "A feeling", "רגש", "Un sentimiento", "Um sentimento", "Un sentiment", "Чувство", "Ein Gefühl", "شعور", "一种感觉", "一種感覺", "감정"],
  ["category.time", "A time", "זמן", "Un momento", "Um tempo", "Un moment", "Время", "Eine Zeit", "وقت", "时间", "時間", "시간"],

  // ── place ──
  ["place.at_home", "At home", "בבית", "En casa", "Em casa", "À la maison", "Дома", "Zu Hause", "في البيت", "在家", "喺屋企", "집에서"],
  ["place.at_school", "At school", "בבית הספר", "En la escuela", "Na escola", "À l'école", "В школе", "In der Schule", "في المدرسة", "在学校", "喺學校", "학교에서"],
  ["place.in_the_city", "In town", "בעיר", "En la ciudad", "Na cidade", "En ville", "В городе", "In der Stadt", "في المدينة", "在城里", "喺城市", "동네에서"],
  ["place.in_nature", "Outside in nature", "בטבע", "En la naturaleza", "Na natureza", "Dans la nature", "На природе", "Draußen in der Natur", "في الطبيعة", "在大自然", "喺大自然", "자연에서"],
  ["place.far_away", "Somewhere far", "רחוק", "En un lugar lejano", "Em algum lugar longe", "Quelque part loin", "Где-то далеко", "Irgendwo weit weg", "مكان بعيد", "很远的地方", "好遠嘅地方", "멀리"],

  // ── home_room ──
  ["home_room.kitchen", "Kitchen", "מטבח", "Cocina", "Cozinha", "Cuisine", "Кухня", "Küche", "المطبخ", "厨房", "廚房", "부엌"],
  ["home_room.bedroom", "Bedroom", "חדר שינה", "Dormitorio", "Quarto", "Chambre", "Спальня", "Schlafzimmer", "غرفة النوم", "卧室", "睡房", "침실"],
  ["home_room.bathroom", "Bathroom", "אמבטיה", "Baño", "Banheiro", "Salle de bain", "Ванная", "Badezimmer", "الحمام", "浴室", "浴室", "욕실"],
  ["home_room.living_room", "Living room", "סלון", "Sala", "Sala", "Salon", "Гостиная", "Wohnzimmer", "غرفة المعيشة", "客厅", "客廳", "거실"],
  ["home_room.closet", "Closet", "ארון", "Armario", "Armário", "Placard", "Шкаф", "Schrank", "الخزانة", "衣柜", "衣櫃", "옷장"],

  // ── school_area ──
  ["school_area.classroom", "Classroom", "כיתה", "Aula", "Sala de aula", "Salle de classe", "Класс", "Klassenzimmer", "الفصل", "教室", "課室", "교실"],
  ["school_area.playground", "Playground", "מגרש משחקים", "Patio", "Parquinho", "Cour de récré", "Площадка", "Spielplatz", "الملعب", "操场", "遊樂場", "놀이터"],
  ["school_area.lunchroom", "Lunchroom", "חדר אוכל", "Comedor", "Refeitório", "Cantine", "Столовая", "Mensa", "غرفة الغداء", "餐厅", "飯堂", "급식실"],

  // ── natural_places ──
  ["natural_places.water", "In the water", "במים", "En el agua", "Na água", "Dans l'eau", "В воде", "Im Wasser", "في الماء", "在水里", "喺水裏", "물속에서"],
  ["natural_places.sky", "In the sky", "בשמיים", "En el cielo", "No céu", "Dans le ciel", "В небе", "Am Himmel", "في السماء", "在天空", "喺天空", "하늘에서"],
  ["natural_places.grass", "In the grass", "בדשא", "En la hierba", "Na grama", "Dans l'herbe", "В траве", "Im Gras", "في العشب", "在草地", "喺草地", "풀밭에서"],
  ["natural_places.forest", "In the forest", "ביער", "En el bosque", "Na floresta", "Dans la forêt", "В лесу", "Im Wald", "في الغابة", "在森林", "喺森林", "숲에서"],
  ["natural_places.mountains", "In the mountains", "בהרים", "En las montañas", "Nas montanhas", "Dans les montagnes", "В горах", "In den Bergen", "في الجبال", "在山里", "喺山度", "산에서"],
  ["natural_places.desert", "In the desert", "במדבר", "En el desierto", "No deserto", "Dans le désert", "В пустыне", "In der Wüste", "في الصحراء", "在沙漠", "喺沙漠", "사막에서"],
  ["natural_places.snow", "In the snow", "בשלג", "En la nieve", "Na neve", "Dans la neige", "В снегу", "Im Schnee", "في الثلج", "在雪里", "喺雪度", "눈 속에서"],
  ["natural_places.underground", "Underground", "מתחת לאדמה", "Bajo tierra", "Embaixo da terra", "Sous terre", "Под землёй", "Unter der Erde", "تحت الأرض", "在地下", "喺地底", "땅속에"],

  // ── body_part ──
  ["body_part.head", "Head", "ראש", "Cabeza", "Cabeça", "Tête", "Голова", "Kopf", "الرأس", "头", "頭", "머리"],
  ["body_part.chest_heart", "Chest", "חזה", "Pecho", "Peito", "Poitrine", "Грудь", "Brust", "الصدر", "胸口", "胸口", "가슴"],
  ["body_part.belly", "Tummy", "בטן", "Barriga", "Barriga", "Ventre", "Живот", "Bauch", "البطن", "肚子", "肚", "배"],
  ["body_part.arm", "Arm", "זרוע", "Brazo", "Braço", "Bras", "Рука", "Arm", "الذراع", "手臂", "手臂", "팔"],
  ["body_part.leg", "Leg", "רגל", "Pierna", "Perna", "Jambe", "Нога", "Bein", "الساق", "腿", "腳", "다리"],
  ["body_part.eye", "Eye", "עין", "Ojo", "Olho", "Œil", "Глаз", "Auge", "العين", "眼睛", "眼", "눈"],
  ["body_part.nose", "Nose", "אף", "Nariz", "Nariz", "Nez", "Нос", "Nase", "الأنف", "鼻子", "鼻", "코"],
  ["body_part.mouth", "Mouth", "פה", "Boca", "Boca", "Bouche", "Рот", "Mund", "الفم", "嘴巴", "嘴", "입"],
  ["body_part.ear", "Ear", "אוזן", "Oreja", "Orelha", "Oreille", "Ухо", "Ohr", "الأذن", "耳朵", "耳仔", "귀"],

  // ── valence ──
  ["valence.good", "A good feeling", "רגש טוב", "Un sentimiento bueno", "Um sentimento bom", "Un bon sentiment", "Хорошее чувство", "Ein gutes Gefühl", "شعور جيد", "好的感觉", "好嘅感覺", "좋은 기분"],
  ["valence.bad", "A bad feeling", "רגש רע", "Un sentimiento malo", "Um sentimento ruim", "Un mauvais sentiment", "Плохое чувство", "Ein schlechtes Gefühl", "شعور سيئ", "不好的感觉", "唔好嘅感覺", "나쁜 기분"],
  ["valence.mixed", "A mixed feeling", "רגש מעורב", "Un sentimiento mezclado", "Um sentimento misto", "Un sentiment mêlé", "Смешанное чувство", "Ein gemischtes Gefühl", "شعور مختلط", "复杂的感觉", "複雜嘅感覺", "복잡한 기분"],

  // ── named_feeling ──
  ["named_feeling.happy", "Happy", "שמח", "Feliz", "Feliz", "Content", "Радостный", "Glücklich", "سعيد", "开心", "開心", "행복해요"],
  ["named_feeling.sad", "Sad", "עצוב", "Triste", "Triste", "Triste", "Грустный", "Traurig", "حزين", "难过", "唔開心", "슬퍼요"],
  ["named_feeling.angry", "Angry", "כועס", "Enojado", "Bravo", "En colère", "Сердитый", "Wütend", "غاضب", "生气", "嬲", "화나요"],
  ["named_feeling.afraid", "Scared", "מפחד", "Asustado", "Com medo", "Effrayé", "Испуганный", "Ängstlich", "خائف", "害怕", "驚", "무서워요"],
  ["named_feeling.hurt", "Hurt", "כואב", "Lastimado", "Machucado", "Blessé", "Больно", "Verletzt", "متألم", "受伤", "痛", "아파요"],
  ["named_feeling.excited", "Excited", "נרגש", "Emocionado", "Animado", "Excité", "Взволнованный", "Aufgeregt", "متحمس", "兴奋", "興奮", "신나요"],
  ["named_feeling.calm", "Calm", "רגוע", "Tranquilo", "Calmo", "Calme", "Спокойный", "Ruhig", "هادئ", "平静", "平靜", "차분해요"],
  ["named_feeling.tired", "Tired", "עייף", "Cansado", "Cansado", "Fatigué", "Усталый", "Müde", "متعب", "累", "攰", "피곤해요"],

  // ── pain_scale ──
  ["pain_scale.a_little", "A little", "קצת", "Un poco", "Um pouco", "Un peu", "Немного", "Ein bisschen", "قليلاً", "一点点", "少少", "조금"],
  ["pain_scale.medium", "Medium", "בינוני", "Medio", "Médio", "Moyen", "Средне", "Mittel", "متوسط", "中等", "中等", "보통"],
  ["pain_scale.a_lot", "A lot", "הרבה", "Mucho", "Muito", "Beaucoup", "Сильно", "Viel", "كثيراً", "很多", "好多", "많이"],

  // ── intensity ──
  ["intensity.strong", "Strong", "חזק", "Fuerte", "Forte", "Fort", "Сильный", "Stark", "قوي", "强烈", "強烈", "강해요"],
  ["intensity.small", "Small", "קטן", "Pequeño", "Pequeno", "Petit", "Слабый", "Klein", "صغير", "微小", "細", "약해요"],

  // ── pace ──
  ["pace.fast", "Fast", "מהר", "Rápido", "Rápido", "Vite", "Быстро", "Schnell", "سريع", "快", "快", "빨라요"],
  ["pace.slow", "Slow", "לאט", "Lento", "Devagar", "Lent", "Медленно", "Langsam", "بطيء", "慢", "慢", "느려요"],

  // ── who ──
  ["who.alone", "By myself", "לבד", "Yo solo", "Sozinho", "Tout seul", "Сам", "Allein", "بمفردي", "自己", "自己", "혼자"],
  ["who.with_others", "With others", "עם אחרים", "Con otros", "Com outros", "Avec d'autres", "С другими", "Mit anderen", "مع آخرين", "和别人", "同其他人", "다른 사람과"],
  ["who.together", "Together", "ביחד", "Juntos", "Juntos", "Ensemble", "Вместе", "Zusammen", "معاً", "一起", "一齊", "함께"],

  // ── action_where ──
  ["action_where.inside", "Inside", "בפנים", "Adentro", "Dentro", "À l'intérieur", "Внутри", "Drinnen", "في الداخل", "在里面", "喺入面", "안에서"],
  ["action_where.outside", "Outside", "בחוץ", "Afuera", "Fora", "Dehors", "Снаружи", "Draußen", "في الخارج", "在外面", "喺出面", "밖에서"],
  ["action_where.on_screen", "On a screen", "על מסך", "En una pantalla", "Numa tela", "Sur un écran", "На экране", "Auf einem Bildschirm", "على الشاشة", "在屏幕上", "喺屏幕上", "화면에서"],

  // ── uses_tool ──
  ["uses_tool.yes_tool", "Use something", "משתמש במשהו", "Uso algo", "Uso algo", "On utilise un truc", "Использую что-то", "Mit etwas", "أستخدم شيئاً", "用东西", "用嘢", "도구를 써요"],
  ["uses_tool.no_tool", "Just my body", "רק הגוף", "Solo mi cuerpo", "Só meu corpo", "Juste mon corps", "Только тело", "Nur mein Körper", "جسدي فقط", "只用身体", "淨係用身體", "몸으로만"],

  // ── purpose ──
  ["purpose.fun", "For fun", "בשביל הכיף", "Por diversión", "Por diversão", "Pour s'amuser", "Для веселья", "Zum Spaß", "للمتعة", "为了好玩", "為咗好玩", "재미로"],
  ["purpose.work", "A job to do", "עבודה", "Un trabajo", "Um trabalho", "Un travail", "Работа", "Eine Aufgabe", "عمل", "要做的事", "要做嘅嘢", "할 일"],

  // ── kind ──
  ["kind.animal", "An animal", "חיה", "Un animal", "Um animal", "Un animal", "Животное", "Ein Tier", "حيوان", "动物", "動物", "동물"],
  ["kind.food", "Food", "אוכל", "Comida", "Comida", "De la nourriture", "Еда", "Essen", "طعام", "食物", "食物", "음식"],
  ["kind.toy", "A toy", "צעצוע", "Un juguete", "Um brinquedo", "Un jouet", "Игрушка", "Ein Spielzeug", "لعبة", "玩具", "玩具", "장난감"],
  ["kind.clothes", "Clothes", "בגדים", "Ropa", "Roupa", "Des vêtements", "Одежда", "Kleidung", "ملابس", "衣服", "衫", "옷"],
  ["kind.tool", "A tool", "כלי", "Una herramienta", "Uma ferramenta", "Un outil", "Инструмент", "Ein Werkzeug", "أداة", "工具", "工具", "도구"],
  ["kind.vehicle", "Something that goes", "משהו שנוסע", "Algo que se mueve", "Algo que anda", "Quelque chose qui roule", "То, что едет", "Etwas, das fährt", "شيء يتحرك", "会动的东西", "會郁嘅嘢", "타는 것"],
  ["kind.screen", "From a screen", "ממסך", "De una pantalla", "De uma tela", "D'un écran", "С экрана", "Vom Bildschirm", "من الشاشة", "来自屏幕", "嚟自屏幕", "화면 속"],
  ["kind.nature_thing", "Something in nature", "משהו בטבע", "Algo de la naturaleza", "Algo da natureza", "Quelque chose dans la nature", "Что-то в природе", "Etwas in der Natur", "شيء في الطبيعة", "大自然的东西", "大自然嘅嘢", "자연 속 사물"],

  // ── size ──
  ["size.tiny", "Tiny", "זעיר", "Diminuto", "Minúsculo", "Minuscule", "Крошечный", "Winzig", "صغير جداً", "很小", "好細", "아주 작아요"],
  ["size.medium", "Medium", "בינוני", "Mediano", "Médio", "Moyen", "Средний", "Mittel", "متوسط", "中等", "中等", "보통"],
  ["size.big", "Big", "גדול", "Grande", "Grande", "Grand", "Большой", "Groß", "كبير", "很大", "大", "커요"],

  // ── color ──
  ["color.red", "Red", "אדום", "Rojo", "Vermelho", "Rouge", "Красный", "Rot", "أحمر", "红色", "紅色", "빨강"],
  ["color.orange_c", "Orange", "כתום", "Naranja", "Laranja", "Orange", "Оранжевый", "Orange", "برتقالي", "橙色", "橙色", "주황"],
  ["color.yellow", "Yellow", "צהוב", "Amarillo", "Amarelo", "Jaune", "Жёлтый", "Gelb", "أصفر", "黄色", "黃色", "노랑"],
  ["color.green", "Green", "ירוק", "Verde", "Verde", "Vert", "Зелёный", "Grün", "أخضر", "绿色", "綠色", "초록"],
  ["color.blue", "Blue", "כחול", "Azul", "Azul", "Bleu", "Синий", "Blau", "أزرق", "蓝色", "藍色", "파랑"],
  ["color.purple", "Purple", "סגול", "Morado", "Roxo", "Violet", "Фиолетовый", "Lila", "بنفسجي", "紫色", "紫色", "보라"],
  ["color.pink", "Pink", "ורוד", "Rosa", "Rosa", "Rose", "Розовый", "Rosa", "وردي", "粉色", "粉紅色", "분홍"],
  ["color.brown", "Brown", "חום", "Marrón", "Marrom", "Marron", "Коричневый", "Braun", "بني", "棕色", "啡色", "갈색"],
  ["color.black", "Black", "שחור", "Negro", "Preto", "Noir", "Чёрный", "Schwarz", "أسود", "黑色", "黑色", "검정"],
  ["color.white", "White", "לבן", "Blanco", "Branco", "Blanc", "Белый", "Weiß", "أبيض", "白色", "白色", "하양"],

  // ── real_or_imagined ──
  ["real_or_imagined.real_thing", "A real thing", "דבר אמיתי", "Algo real", "Algo real", "Une chose réelle", "Настоящая вещь", "Etwas Echtes", "شيء حقيقي", "真实的东西", "真實嘅嘢", "진짜 사물"],
  ["real_or_imagined.from_a_show", "From a show or game", "מתוכנית או משחק", "De un show o juego", "De um show ou jogo", "D'une série ou d'un jeu", "Из шоу или игры", "Aus einer Show oder einem Spiel", "من برنامج أو لعبة", "来自节目或游戏", "嚟自節目或遊戲", "쇼나 게임 속"],

  // ── where_known ──
  ["where_known.real_life", "Seen it for real", "ראיתי באמת", "Lo vi de verdad", "Vi de verdade", "Vu en vrai", "Видел вживую", "Echt gesehen", "رأيته حقيقة", "真的见过", "真係見過", "실제로 봤어요"],
  ["where_known.on_screen_known", "On a screen", "על מסך", "En una pantalla", "Numa tela", "Sur un écran", "На экране", "Auf einem Bildschirm", "على الشاشة", "在屏幕上", "喺屏幕上", "화면에서"],
  ["where_known.in_a_book", "In a book", "בספר", "En un libro", "Num livro", "Dans un livre", "В книге", "In einem Buch", "في كتاب", "在书里", "喺書度", "책에서"],

  // ── animal_covering ──
  ["animal_covering.furry", "Furry", "פרוותי", "Peludo", "Peludo", "À fourrure", "Пушистый", "Pelzig", "فروي", "毛茸茸", "毛茸茸", "털이 있어요"],
  ["animal_covering.feathers", "Feathers", "נוצות", "Plumas", "Penas", "Des plumes", "Перья", "Federn", "ريش", "羽毛", "羽毛", "깃털"],
  ["animal_covering.scales", "Scales", "קשקשים", "Escamas", "Escamas", "Des écailles", "Чешуя", "Schuppen", "حراشف", "鳞片", "鱗片", "비늘"],
  ["animal_covering.shell", "A shell", "שריון", "Caparazón", "Casca", "Une carapace", "Панцирь", "Panzer", "صدفة", "壳", "殼", "껍데기"],
  ["animal_covering.skin", "Smooth skin", "עור חלק", "Piel lisa", "Pele lisa", "Peau lisse", "Гладкая кожа", "Glatte Haut", "جلد أملس", "光滑皮肤", "光滑皮膚", "매끈한 피부"],

  // ── animal_diet ──
  ["animal_diet.eats_meat", "Eats meat", "אוכל בשר", "Come carne", "Come carne", "Mange de la viande", "Ест мясо", "Frisst Fleisch", "يأكل اللحم", "吃肉", "食肉", "고기를 먹어요"],
  ["animal_diet.eats_plants", "Eats plants", "אוכל צמחים", "Come plantas", "Come plantas", "Mange des plantes", "Ест растения", "Frisst Pflanzen", "يأكل النباتات", "吃植物", "食植物", "식물을 먹어요"],
  ["animal_diet.eats_fish", "Eats fish", "אוכל דגים", "Come pescado", "Come peixe", "Mange du poisson", "Ест рыбу", "Frisst Fisch", "يأكل السمك", "吃鱼", "食魚", "물고기를 먹어요"],
  ["animal_diet.eats_bugs", "Eats bugs", "אוכל חרקים", "Come insectos", "Come insetos", "Mange des insectes", "Ест насекомых", "Frisst Insekten", "يأكل الحشرات", "吃虫子", "食昆蟲", "벌레를 먹어요"],
  ["animal_diet.eats_many", "Eats lots of things", "אוכל הרבה דברים", "Come de todo", "Come de tudo", "Mange de tout", "Ест много всего", "Frisst vieles", "يأكل أشياء كثيرة", "什么都吃", "乜都食", "여러 가지를 먹어요"],

  // ── taste ──
  ["taste.sweet", "Sweet", "מתוק", "Dulce", "Doce", "Sucré", "Сладкий", "Süß", "حلو", "甜", "甜", "달아요"],
  ["taste.salty", "Salty", "מלוח", "Salado", "Salgado", "Salé", "Солёный", "Salzig", "مالح", "咸", "鹹", "짜요"],
  ["taste.sour", "Sour", "חמוץ", "Agrio", "Azedo", "Acide", "Кислый", "Sauer", "حامض", "酸", "酸", "셔요"],
  ["taste.plain", "Plain", "רגיל", "Simple", "Sem graça", "Nature", "Простой", "Neutral", "عادي", "清淡", "清淡", "담백해요"],

  // ── temperature ──
  ["temperature.hot", "Hot", "חם", "Caliente", "Quente", "Chaud", "Горячий", "Heiß", "ساخن", "热", "熱", "뜨거워요"],
  ["temperature.warm", "Warm", "פושר", "Tibio", "Morno", "Tiède", "Тёплый", "Warm", "دافئ", "温的", "暖", "따뜻해요"],
  ["temperature.cold", "Cold", "קר", "Frío", "Frio", "Froid", "Холодный", "Kalt", "بارد", "冷", "凍", "차가워요"],

  // ── food_texture ──
  ["food_texture.crunchy", "Crunchy", "פריך", "Crujiente", "Crocante", "Croquant", "Хрустящий", "Knusprig", "مقرمش", "脆", "脆", "바삭해요"],
  ["food_texture.soft_food", "Soft", "רך", "Blando", "Macio", "Mou", "Мягкий", "Weich", "طري", "软", "軟", "부드러워요"],
  ["food_texture.liquid_food", "A drink", "משקה", "Una bebida", "Uma bebida", "Une boisson", "Напиток", "Ein Getränk", "مشروب", "饮料", "飲品", "마시는 거"],

  // ── food_when ──
  ["food_when.breakfast", "Breakfast", "ארוחת בוקר", "Desayuno", "Café da manhã", "Petit-déjeuner", "Завтрак", "Frühstück", "فطور", "早餐", "早餐", "아침"],
  ["food_when.lunch", "Lunch", "ארוחת צהריים", "Almuerzo", "Almoço", "Déjeuner", "Обед", "Mittagessen", "غداء", "午餐", "午餐", "점심"],
  ["food_when.dinner", "Dinner", "ארוחת ערב", "Cena", "Jantar", "Dîner", "Ужин", "Abendessen", "عشاء", "晚餐", "晚餐", "저녁"],
  ["food_when.snack", "A snack", "חטיף", "Un snack", "Um lanche", "Un goûter", "Перекус", "Ein Snack", "وجبة خفيفة", "零食", "小食", "간식"],
  ["food_when.treat", "A treat", "פינוק", "Un dulce", "Um docinho", "Une gâterie", "Лакомство", "Eine Leckerei", "حلوى", "甜点", "甜品", "간식거리"],

  // ── clothes_when ──
  ["clothes_when.everyday", "Every day", "כל יום", "Para diario", "Do dia a dia", "Tous les jours", "На каждый день", "Alltäglich", "كل يوم", "每天穿", "日日著", "매일"],
  ["clothes_when.fancy", "Fancy", "מהודר", "Elegante", "Chique", "Chic", "Нарядный", "Schick", "أنيق", "漂亮的", "靚", "멋진"],
  ["clothes_when.weather_clothes", "For the weather", "לפי מזג האוויר", "Para el clima", "Para o clima", "Pour la météo", "Для погоды", "Fürs Wetter", "حسب الطقس", "看天气穿", "睇天氣", "날씨용"],

  // ── toy_form ──
  ["toy_form.physical_toy", "A real toy", "צעצוע אמיתי", "Un juguete de verdad", "Um brinquedo de verdade", "Un vrai jouet", "Настоящая игрушка", "Ein echtes Spielzeug", "لعبة حقيقية", "真的玩具", "真實玩具", "진짜 장난감"],
  ["toy_form.video_game", "A video game", "משחק וידאו", "Un videojuego", "Um videogame", "Un jeu vidéo", "Видеоигра", "Ein Videospiel", "لعبة فيديو", "电子游戏", "電子遊戲", "비디오 게임"],
  ["toy_form.app", "An app", "אפליקציה", "Una app", "Um app", "Une appli", "Приложение", "Eine App", "تطبيق", "应用程序", "應用程式", "앱"],
  ["toy_form.show_toy", "From a show", "מתוכנית", "De un show", "De um show", "D'une série", "Из шоу", "Aus einer Show", "من برنامج", "来自节目", "嚟自節目", "쇼 속"],

  // ── play_style ──
  ["play_style.play_alone", "Play by myself", "משחק לבד", "Jugar solo", "Brincar sozinho", "Jouer seul", "Играть одному", "Allein spielen", "ألعب وحدي", "自己玩", "自己玩", "혼자 놀아요"],
  ["play_style.play_together", "Play together", "משחק ביחד", "Jugar juntos", "Brincar juntos", "Jouer ensemble", "Играть вместе", "Zusammen spielen", "نلعب معاً", "一起玩", "一齊玩", "같이 놀아요"],

  // ── tool_purpose ──
  ["tool_purpose.draw_write", "To draw or write", "לצייר או לכתוב", "Para dibujar o escribir", "Para desenhar ou escrever", "Pour dessiner ou écrire", "Чтобы рисовать или писать", "Zum Malen oder Schreiben", "للرسم أو الكتابة", "用来画画或写字", "用嚟畫畫或寫字", "그리거나 쓰는 것"],
  ["tool_purpose.eat_tool", "To eat with", "לאכול איתו", "Para comer", "Para comer", "Pour manger", "Чтобы есть", "Zum Essen", "للأكل", "用来吃饭", "用嚟食嘢", "먹을 때 쓰는 것"],
  ["tool_purpose.clean_tool", "To clean", "לנקות", "Para limpiar", "Para limpar", "Pour nettoyer", "Чтобы убирать", "Zum Putzen", "للتنظيف", "用来打扫", "用嚟清潔", "청소하는 것"],
  ["tool_purpose.fix_tool", "To fix things", "לתקן", "Para arreglar", "Para consertar", "Pour réparer", "Чтобы чинить", "Zum Reparieren", "للإصلاح", "用来修理", "用嚟整嘢", "고치는 것"],
  ["tool_purpose.move_tool", "To help me move", "לעזור לי לזוז", "Para moverme", "Para me mover", "Pour m'aider à bouger", "Чтобы двигаться", "Zum Fortbewegen", "لمساعدتي على الحركة", "帮我移动", "幫我郁動", "이동을 돕는 것"],

  // ── vehicle_domain ──
  ["vehicle_domain.land", "On land", "על היבשה", "En tierra", "Em terra", "Sur terre", "По земле", "Auf dem Land", "على البر", "在陆地", "喺陸地", "땅에서"],
  ["vehicle_domain.water", "On water", "על המים", "En el agua", "Na água", "Sur l'eau", "По воде", "Auf dem Wasser", "على الماء", "在水上", "喺水上", "물에서"],
  ["vehicle_domain.air", "In the air", "באוויר", "En el aire", "No ar", "Dans les airs", "По воздуху", "In der Luft", "في الجو", "在空中", "喺空中", "하늘에서"],
  ["vehicle_domain.space", "In space", "בחלל", "En el espacio", "No espaço", "Dans l'espace", "В космосе", "Im Weltraum", "في الفضاء", "在太空", "喺太空", "우주에서"],

  // ── screen_medium ──
  ["screen_medium.show", "A TV show", "תוכנית טלוויזיה", "Un programa", "Um programa", "Une émission", "Телешоу", "Eine TV-Sendung", "برنامج تلفزيوني", "电视节目", "電視節目", "TV 프로그램"],
  ["screen_medium.movie", "A movie", "סרט", "Una película", "Um filme", "Un film", "Фильм", "Ein Film", "فيلم", "电影", "電影", "영화"],
  ["screen_medium.video_game", "A video game", "משחק וידאו", "Un videojuego", "Um videogame", "Un jeu vidéo", "Видеоигра", "Ein Videospiel", "لعبة فيديو", "电子游戏", "電子遊戲", "비디오 게임"],
  ["screen_medium.app", "An app", "אפליקציה", "Una app", "Um app", "Une appli", "Приложение", "Eine App", "تطبيق", "应用程序", "應用程式", "앱"],
  ["screen_medium.youtube", "A video", "סרטון", "Un video", "Um vídeo", "Une vidéo", "Видео", "Ein Video", "فيديو", "视频", "影片", "동영상"],

  // ── screen_subject ──
  ["screen_subject.character", "A character", "דמות", "Un personaje", "Um personagem", "Un personnage", "Персонаж", "Eine Figur", "شخصية", "一个角色", "一個角色", "캐릭터"],
  ["screen_subject.place_in_it", "A place in it", "מקום בתוכו", "Un lugar de eso", "Um lugar nele", "Un endroit dedans", "Место в нём", "Ein Ort darin", "مكان فيه", "里面的地方", "入面嘅地方", "그 안의 장소"],
  ["screen_subject.thing_in_it", "A thing in it", "דבר בתוכו", "Una cosa de eso", "Uma coisa nele", "Une chose dedans", "Вещь в нём", "Ein Ding darin", "شيء فيه", "里面的东西", "入面嘅嘢", "그 안의 사물"],

  // ── nature_kind ──
  ["nature_kind.plant", "A plant", "צמח", "Una planta", "Uma planta", "Une plante", "Растение", "Eine Pflanze", "نبات", "植物", "植物", "식물"],
  ["nature_kind.weather", "Weather", "מזג אוויר", "El clima", "O clima", "La météo", "Погода", "Wetter", "الطقس", "天气", "天氣", "날씨"],
  ["nature_kind.water_body", "Water", "מים", "Agua", "Água", "De l'eau", "Вода", "Wasser", "ماء", "水", "水", "물"],
  ["nature_kind.sky_thing", "In the sky", "בשמיים", "En el cielo", "No céu", "Dans le ciel", "В небе", "Am Himmel", "في السماء", "在天空", "喺天空", "하늘에"],
  ["nature_kind.ground_thing", "On the ground", "על האדמה", "En el suelo", "No chão", "Sur le sol", "На земле", "Auf dem Boden", "على الأرض", "在地上", "喺地上", "땅에"],

  // ── relationship ──
  ["relationship.family", "Family", "משפחה", "Familia", "Família", "La famille", "Семья", "Familie", "العائلة", "家人", "家人", "가족"],
  ["relationship.friend", "A friend", "חבר", "Un amigo", "Um amigo", "Un ami", "Друг", "Ein Freund", "صديق", "朋友", "朋友", "친구"],
  ["relationship.helper", "Someone who helps", "מישהו שעוזר", "Alguien que ayuda", "Alguém que ajuda", "Quelqu'un qui aide", "Тот, кто помогает", "Jemand, der hilft", "شخص يساعد", "帮忙的人", "幫手嘅人", "도와주는 사람"],
  ["relationship.new_person", "Someone new", "מישהו חדש", "Alguien nuevo", "Alguém novo", "Quelqu'un de nouveau", "Кто-то новый", "Jemand Neues", "شخص جديد", "新的人", "新嘅人", "새로운 사람"],

  // ── presence ──
  ["presence.here_now", "Here now", "כאן עכשיו", "Aquí ahora", "Aqui agora", "Ici maintenant", "Здесь сейчас", "Jetzt hier", "هنا الآن", "现在在这里", "而家喺度", "지금 여기"],
  ["presence.not_here", "Not here", "לא כאן", "No está aquí", "Não está aqui", "Pas ici", "Не здесь", "Nicht hier", "ليس هنا", "不在这里", "唔喺度", "여기 없어요"],

  // ── activity ──
  ["activity.eat_there", "Eat there", "אוכלים שם", "Comer ahí", "Comer lá", "On y mange", "Там едят", "Dort essen", "نأكل هناك", "在那里吃", "喺嗰度食", "거기서 먹어요"],
  ["activity.play_there", "Play there", "משחקים שם", "Jugar ahí", "Brincar lá", "On y joue", "Там играют", "Dort spielen", "نلعب هناك", "在那里玩", "喺嗰度玩", "거기서 놀아요"],
  ["activity.learn_there", "Learn there", "לומדים שם", "Aprender ahí", "Aprender lá", "On y apprend", "Там учатся", "Dort lernen", "نتعلم هناك", "在那里学习", "喺嗰度學嘢", "거기서 배워요"],
  ["activity.rest_there", "Rest there", "נחים שם", "Descansar ahí", "Descansar lá", "On s'y repose", "Там отдыхают", "Dort ausruhen", "نرتاح هناك", "在那里休息", "喺嗰度休息", "거기서 쉬어요"],
  ["activity.shop_there", "Shop there", "קונים שם", "Comprar ahí", "Comprar lá", "On y fait les courses", "Там покупают", "Dort einkaufen", "نتسوق هناك", "在那里购物", "喺嗰度買嘢", "거기서 사요"],
  ["activity.get_help", "Get help there", "מקבלים עזרה שם", "Pedir ayuda ahí", "Pedir ajuda lá", "On y trouve de l'aide", "Там помогают", "Dort Hilfe holen", "نطلب المساعدة هناك", "在那里求助", "喺嗰度求助", "거기서 도움받아요"],

  // ── time ──
  ["time.now", "Now", "עכשיו", "Ahora", "Agora", "Maintenant", "Сейчас", "Jetzt", "الآن", "现在", "而家", "지금"],
  ["time.earlier_today", "Earlier today", "קודם היום", "Hoy más temprano", "Mais cedo hoje", "Plus tôt aujourd'hui", "Сегодня раньше", "Heute früher", "في وقت سابق اليوم", "今天早些时候", "今日早啲", "오늘 아까"],
  ["time.yesterday", "Yesterday", "אתמול", "Ayer", "Ontem", "Hier", "Вчера", "Gestern", "أمس", "昨天", "琴日", "어제"],
  ["time.long_ago", "A long time ago", "מזמן", "Hace mucho", "Há muito tempo", "Il y a longtemps", "Давно", "Vor langer Zeit", "منذ زمن طويل", "很久以前", "好耐之前", "오래전"],
  ["time.soon", "Soon", "בקרוב", "Pronto", "Em breve", "Bientôt", "Скоро", "Bald", "قريباً", "很快", "好快", "곧"],
  ["time.later", "Later", "אחר כך", "Más tarde", "Mais tarde", "Plus tard", "Позже", "Später", "لاحقاً", "待会儿", "遲啲", "나중에"],
  ["time.bedtime", "Bedtime", "שעת שינה", "Hora de dormir", "Hora de dormir", "L'heure du coucher", "Время сна", "Schlafenszeit", "وقت النوم", "睡觉时间", "瞓覺時間", "잘 시간"],
  ["time.mealtime", "Mealtime", "שעת ארוחה", "Hora de comer", "Hora de comer", "L'heure du repas", "Время еды", "Essenszeit", "وقت الوجبة", "吃饭时间", "食飯時間", "식사 시간"],
  ["time.school_time", "School time", "שעת בית ספר", "Hora de la escuela", "Hora da escola", "L'heure de l'école", "Время школы", "Schulzeit", "وقت المدرسة", "上学时间", "返學時間", "학교 시간"],
];

function buildBlock(localeIdx: number): string {
  // Group rows by cluster (rows are already cluster-contiguous).
  const lines: string[] = ["  guessing: {"];
  let currentCluster = "";
  for (const row of TABLE) {
    const [keyPath, ...vals] = row;
    const [cluster, value] = keyPath.split(".");
    if (cluster !== currentCluster) {
      if (currentCluster !== "") lines.push("    },");
      lines.push(`    ${cluster}: {`);
      currentCluster = cluster;
    }
    const v = vals[localeIdx];
    lines.push(`      ${value}: ${JSON.stringify(v)},`);
  }
  lines.push("    },");
  lines.push("  },");
  return lines.join("\n") + "\n";
}

let updated = 0;
for (let i = 0; i < LOCALES.length; i++) {
  const file = path.join(I18N_DIR, `${LOCALES[i]}.ts`);
  let content = fs.readFileSync(file, "utf-8");
  if (/\n\s*guessing\s*:\s*\{/.test(content)) {
    console.log(`skip ${LOCALES[i]}.ts — already has guessing block`);
    continue;
  }
  const marker = content.lastIndexOf("\n};");
  if (marker < 0) {
    console.error(`!! ${LOCALES[i]}.ts — could not find closing '};'`);
    continue;
  }
  const block = buildBlock(i);
  content = content.slice(0, marker + 1) + block + content.slice(marker + 1);
  fs.writeFileSync(file, content, "utf-8");
  updated++;
  console.log(`updated ${LOCALES[i]}.ts`);
}
console.log(`\nDone — ${updated} file(s) updated, ${TABLE.length} keys each.`);
