const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');

// --- UTILITY: A single, reusable database connection function ---
async function connectToDatabase() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not defined in environment variables.');
    
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db();
    return { db, client };
}

// --- MAIN HANDLER for Netlify serverless function ---
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { db, client } = await connectToDatabase();
    const usersCollection = db.collection('users');
    
    try {
        const { action, payload, token } = JSON.parse(event.body);
        let userData;

        const protectedActions = [
            'getPortfolio', 'executeTrade', 'getStudentRoster', 'addStudent', 'removeStudent',
            'updateStudentCash', 'getQuotes', 'getCompanyNews', 'simplifyNews', 'setCachedNews',
            'intelligentSearch', 'getCompanyExplanation', 'getPortfolioAnalysis', 'getChartData',
            'validateSession'
        ];

        if (protectedActions.includes(action)) {
            if (!token) throw new Error('Authentication token is required.');
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userData = { userId: decoded.userId, username: decoded.username, role: decoded.role };
            if (!userData) throw new Error('Invalid or expired session.');
        }

        let responseData;
        switch (action) {
            case 'registerUser':
                responseData = await registerUser(usersCollection, payload);
                break;
            case 'loginUser':
                responseData = await loginUser(usersCollection, payload);
                break;
            case 'validateSession':
                responseData = userData;
                break;
            case 'addStudent':
                if (userData.role !== 'teacher') throw new Error('Access Denied');
                responseData = await addStudent(usersCollection, { ...payload, teacherId: userData.userId });
                break;
            case 'getStudentRoster':
                if (userData.role !== 'teacher') throw new Error('Access Denied');
                responseData = await getStudentRoster(usersCollection, userData.userId);
                break;
            case 'removeStudent':
                if (userData.role !== 'teacher') throw new Error('Access Denied');
                responseData = await removeStudent(usersCollection, payload.studentId, userData.userId);
                break;
            case 'updateStudentCash':
                 if (userData.role !== 'teacher') throw new Error('Access Denied');
                 responseData = await updateStudentCash(usersCollection, payload.studentId, payload.amount, userData.userId);
                 break;
            case 'getPortfolio':
                responseData = await getPortfolio(usersCollection, userData.userId);
                break;
            case 'executeTrade':
                responseData = await executeTrade(usersCollection, userData.userId, payload);
                break;
            case 'getQuotes':
                responseData = await getQuotes(payload.symbols);
                break;
            case 'getCompanyNews':
                 responseData = await getCompanyNews(db.collection('newsCache'), payload.symbols);
                 break;
            case 'getChartData':
                responseData = await getChartData(payload.symbol);
                break;
            case 'intelligentSearch':
                responseData = await intelligentSearch(payload.query);
                break;
            case 'getCompanyExplanation':
                responseData = await getCompanyExplanation(db.collection('explanationCache'), payload.companyName, payload.symbol);
                break;
            case 'simplifyNews':
                responseData = await simplifyNews(payload.headline, payload.summary);
                break;
            case 'setCachedNews':
                 await db.collection('newsCache').updateOne({ headline: payload.headline }, { $set: { simplifiedText: payload.simplifiedText } }, { upsert: true });
                 responseData = { success: true };
                 break;
            case 'getPortfolioAnalysis':
                responseData = await getPortfolioAnalysis(userData.username, payload.portfolioSummary);
                break;
            default:
                throw new Error(`Unknown action: ${action}`);
        }
        
        return { statusCode: 200, body: JSON.stringify({ data: responseData }) };

    } catch (error) {
        console.error('API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ message: error.message }) };
    } finally {
        await client.close();
    }
};

// --- AUTHENTICATION & USER FUNCTIONS ---
async function registerUser(collection, { username, password, isTeacher }) {
    if (!username || !password) throw new Error('Username and password are required.');
    const existingUser = await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (existingUser) throw new Error('Username already exists.');
    const hashedPassword = await bcrypt.hash(password, 10);
    const role = isTeacher ? 'teacher' : 'student';
    const newUser = { username, hashedPassword, role, cash: role === 'student' ? 100000 : 0, stocks: [], teacherId: null };
    await collection.insertOne(newUser);
    return { success: true, message: 'User registered successfully.' };
}

async function loginUser(collection, { username, password }) {
    if (!username || !password) throw new Error('Username and password are required.');
    const user = await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (!user) throw new Error('Invalid credentials.');
    const isMatch = await bcrypt.compare(password, user.hashedPassword);
    if (!isMatch) throw new Error('Invalid credentials.');
    const token = jwt.sign({ userId: user._id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h' });
    return { token, userData: { userId: user._id, username: user.username, role: user.role } };
}

// --- TEACHER & ROSTER FUNCTIONS ---
async function addStudent(collection, { username, password, startingCash, teacherId }) {
    const existingUser = await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (existingUser) throw new Error('Username already exists.');
    const hashedPassword = await bcrypt.hash(password, 10);
    const newStudent = { username, hashedPassword, role: 'student', cash: startingCash || 100000, stocks: [], teacherId: new ObjectId(teacherId) };
    await collection.insertOne(newStudent);
    return newStudent;
}

async function getStudentRoster(collection, teacherId) {
    return await collection.find({ teacherId: new ObjectId(teacherId) }).project({ hashedPassword: 0 }).toArray();
}

async function removeStudent(collection, studentId, teacherId) {
    const result = await collection.deleteOne({ _id: new ObjectId(studentId), teacherId: new ObjectId(teacherId) });
    if (result.deletedCount === 0) throw new Error('Student not found or you do not have permission to remove them.');
    return { success: true };
}

async function updateStudentCash(collection, studentId, amount, teacherId) {
    const result = await collection.updateOne({ _id: new ObjectId(studentId), teacherId: new ObjectId(teacherId) }, { $inc: { cash: amount } });
    if (result.matchedCount === 0) throw new Error('Student not found or you do not have permission to update them.');
    return { success: true };
}

// --- PORTFOLIO & TRADING FUNCTIONS ---
async function getPortfolio(collection, userId) {
    const user = await collection.findOne({ _id: new ObjectId(userId) }, { projection: { cash: 1, stocks: 1 } });
    if (!user) throw new Error('User not found.');
    return user;
}

async function executeTrade(collection, userId, { type, symbol, quantity, price }) {
    const user = await collection.findOne({ _id: new ObjectId(userId) });
    if (!user) throw new Error('User not found.');
    let { cash, stocks } = user;
    stocks = stocks || [];
    if (type === 'buy') {
        const totalCost = quantity * price;
        if (totalCost > cash) throw new Error('Not enough cash.');
        cash -= totalCost;
        const existingStock = stocks.find(s => s.symbol === symbol);
        if (existingStock) {
            const newTotalShares = existingStock.shares + quantity;
            const newPurchaseValue = (existingStock.shares * existingStock.purchasePrice) + totalCost;
            existingStock.purchasePrice = newPurchaseValue / newTotalShares;
            existingStock.shares = newTotalShares;
        } else {
            stocks.push({ symbol, shares: quantity, purchasePrice: price, purchaseDate: Math.floor(Date.now() / 1000) });
        }
    } else if (type === 'sell') {
        const existingStock = stocks.find(s => s.symbol === symbol);
        if (!existingStock || existingStock.shares < quantity) throw new Error('Not enough shares to sell.');
        cash += quantity * price;
        existingStock.shares -= quantity;
        if (existingStock.shares === 0) {
            stocks = stocks.filter(s => s.symbol !== symbol);
        }
    } else {
        throw new Error('Invalid trade type.');
    }
    await collection.updateOne({ _id: new ObjectId(userId) }, { $set: { cash, stocks } });
    return { success: true };
}

// --- ALPHA VANTAGE DATA PROXY FUNCTIONS ---
async function alphaVantageApiCall(params) {
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) throw new Error('Alpha Vantage API key is not configured on the server.');
    const url = `https://www.alphavantage.co/query?${params}&apikey=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch data from Alpha Vantage.');
    const data = await response.json();
    if (data["Error Message"] || data["Information"]) {
        throw new Error(data["Error Message"] || data["Information"]);
    }
    return data;
}

async function getQuotes(symbols) {
    const quotePromises = symbols.map(async symbol => {
        const data = await alphaVantageApiCall(`function=GLOBAL_QUOTE&symbol=${symbol}`);
        const quoteData = data["Global Quote"];
        return { [symbol]: { c: parseFloat(quoteData["05. price"]) } };
    });
    const quotesArray = await Promise.all(quotePromises);
    return Object.assign({}, ...quotesArray);
}

async function getCompanyNews(cacheCollection, symbols) {
    // Note: AlphaVantage news is not symbol-specific in the same way, so we get general market news
    const data = await alphaVantageApiCall(`function=NEWS_SENTIMENT&topics=technology,financial_markets`);
    let allNews = (data.feed || []).slice(0, 10);
    // ... (rest of the caching logic remains the same)
    const headlines = allNews.map(n => n.title);
    const cachedItems = await cacheCollection.find({ headline: { $in: headlines } }).toArray();
    const cacheMap = new Map(cachedItems.map(item => [item.headline, item.simplifiedText]));
    allNews.forEach(newsItem => {
        if (cacheMap.has(newsItem.title)) {
            newsItem.simplifiedText = cacheMap.get(newsItem.title);
        }
        // Standardize format to match frontend expectations from Finnhub
        newsItem.headline = newsItem.title;
        newsItem.summary = newsItem.summary;
        newsItem.url = newsItem.url;
        newsItem.datetime = new Date(newsItem.time_published).getTime() / 1000;
        newsItem.id = newsItem.url; // Use URL for a unique ID
    });
    return allNews;
}

async function getChartData(symbol) {
    const data = await alphaVantageApiCall(`function=TIME_SERIES_DAILY&symbol=${symbol}`);
    const timeSeries = data["Time Series (Daily)"];
    if (!timeSeries) throw new Error("No chart data available for this symbol.");
    const labels = Object.keys(timeSeries).reverse();
    const chartData = labels.map(label => parseFloat(timeSeries[label]["4. close"]));
    // Standardize to Finnhub-like format
    return {
        c: chartData,
        t: labels.map(label => new Date(label).getTime() / 1000),
        s: 'ok'
    };
}

// --- AI-POWERED FUNCTIONS (OPENAI) ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function intelligentSearch(query) {
    const searchData = await alphaVantageApiCall(`function=SYMBOL_SEARCH&keywords=${query}`);
    const results = searchData.bestMatches || [];
    return results.map(r => ({
        symbol: r["1. symbol"],
        description: r["2. name"]
    })).filter(r => !r.symbol.includes('.')); // Filter out non-US stocks
}

async function getCompanyExplanation(cacheCollection, companyName, symbol) {
    const cached = await cacheCollection.findOne({ symbol });
    if (cached) return { explanation: cached.explanation };

    const completion = await openai.chat.completions.create({
        messages: [
            { role: 'system', content: "You are a financial analyst explaining a company to a 4th grader. Your tone should be simple, direct, and informative. First, state what goods or services the company sells. Second, make a brief, neutral statement about its recent performance (e.g., 'the stock has seen growth' or 'has faced challenges'). Finally, state a potential reason someone might consider investing, and a potential risk. Do not give advice. Output only the explanation." },
            { role: 'user', content: `Explain "${companyName}" (${symbol}).` }
        ],
        model: 'gpt-3.5-turbo',
    });

    const explanation = completion.choices[0].message.content.trim();
    await cacheCollection.updateOne({ symbol }, { $set: { explanation } }, { upsert: true });
    
    return { explanation };
}

async function simplifyNews(headline, summary) {
    const completion = await openai.chat.completions.create({
        messages: [
            { role: 'system', content: "You are an expert at simplifying financial news for a 4th grader. Rewrite the following news summary in simple, easy-to-understand language. Explain what it means for the company. Output only the simplified text." },
            { role: 'user', content: `Headline: ${headline}\nSummary: ${summary}` }
        ],
        model: 'gpt-3.5-turbo',
    });
    return { simplifiedText: completion.choices[0].message.content.trim() };
}

async function getPortfolioAnalysis(username, portfolioSummary) {
    const completion = await openai.chat.completions.create({
        messages: [
            { role: 'system', content: "You are a friendly and encouraging financial coach for kids. Your role is to look at a student's stock portfolio and provide simple, positive feedback. Explain concepts like diversification and performance in easy-to-understand terms. DO NOT give financial advice. Keep the analysis to 2-3 short paragraphs. Address the student by name." },
            { role: 'user', content: `Here is ${username}'s portfolio summary: ${JSON.stringify(portfolioSummary)}. Please provide a simple analysis.` }
        ],
        model: 'gpt-3.5-turbo',
    });
    return { analysis: completion.choices[0].message.content.trim() };
}

