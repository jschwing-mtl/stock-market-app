const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');

// --- DATABASE CONNECTION CACHING ---
let cachedDb = null;
async function connectToDatabase() {
    if (cachedDb) return cachedDb;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not defined.');
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db('stock-market-app');
    cachedDb = db;
    return db;
}

// --- MAIN HANDLER for Vercel ---
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    try {
        const db = await connectToDatabase();
        const { action, payload, token } = req.body;
        let userData;

        const protectedActions = ['getPortfolio', 'executeTrade', 'getStudentRoster', 'addStudent', 'removeStudent', 'updateStudentCash', 'updateTeacherCash', 'updateStudentCredentials', 'getQuotes', 'getCompanyNews', 'simplifyNews', 'setCachedNews', 'intelligentSearch', 'getCompanyExplanation', 'getPortfolioAnalysis', 'getChartData', 'validateSession', 'getLeaderboards', 'checkAndAwardAchievements', 'getStockIndustries'];
        
        if (protectedActions.includes(action)) {
            if (!token) throw new Error('Authentication token is required.');
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userData = { userId: decoded.userId, username: decoded.username, role: decoded.role };
        }

        let responseData;
        switch (action) {
            case 'registerUser': responseData = await registerUser(db.collection('users'), payload); break;
            case 'loginUser': responseData = await loginUser(db.collection('users'), payload); break;
            case 'validateSession': responseData = userData; break;
            case 'addStudent': if (userData.role !== 'teacher') throw new Error('Access Denied'); responseData = await addStudent(db.collection('users'), { ...payload, teacherId: userData.userId }); break;
            case 'getStudentRoster': if (userData.role !== 'teacher') throw new Error('Access Denied'); responseData = await getStudentRoster(db.collection('users'), userData.userId); break;
            case 'removeStudent': if (userData.role !== 'teacher') throw new Error('Access Denied'); responseData = await removeStudent(db.collection('users'), payload.studentId, userData.userId); break;
            case 'updateStudentCash': if (userData.role !== 'teacher') throw new Error('Access Denied'); responseData = await updateStudentCash(db.collection('users'), payload.studentId, payload.amount, userData.userId); break;
            case 'updateTeacherCash': if (userData.role !== 'teacher') throw new Error('Access Denied'); responseData = await updateTeacherCash(db.collection('users'), userData.userId, payload.amount); break;
            case 'updateStudentCredentials': if (userData.role !== 'teacher') throw new Error('Access Denied'); responseData = await updateStudentCredentials(db.collection('users'), payload.studentId, userData.userId, payload.newUsername, payload.newPassword); break;
            case 'getPortfolio': responseData = await getPortfolio(db.collection('users'), userData.userId); break;
            case 'executeTrade': responseData = await executeTrade(db.collection('users'), userData.userId, payload); break;
            case 'getQuotes': responseData = await getQuotes(payload.symbols); break;
            case 'getCompanyNews': responseData = await getCompanyNews(db.collection('newsCache'), payload.symbols); break;
            case 'getChartData': responseData = await getChartData(payload.symbol); break;
            case 'intelligentSearch': responseData = await intelligentSearch(payload.query); break;
            case 'getCompanyExplanation': responseData = await getCompanyExplanation(db.collection('explanationCache'), payload.companyName, payload.symbol); break;
            case 'simplifyNews': responseData = await simplifyNews(payload.headline, payload.summary); break;
            case 'setCachedNews': await db.collection('newsCache').updateOne({ headline: payload.headline }, { $set: { simplifiedText: payload.simplifiedText } }, { upsert: true }); responseData = { success: true }; break;
            case 'getPortfolioAnalysis': responseData = await getPortfolioAnalysis(userData.username, payload.portfolioSummary); break;
            case 'getLeaderboards': responseData = await getLeaderboards(db.collection('users'), userData); break;
            case 'checkAndAwardAchievements': responseData = await checkAndAwardAchievements(db, userData.userId); break;
            case 'getStockIndustries': responseData = await getStockIndustries(payload.symbols); break; 
            default: throw new Error(`Unknown action: ${action}`);
        }
        
        return res.status(200).json({ data: responseData });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ message: error.message });
    }
}

// --- AUTH & USER ---
async function registerUser(collection, { username, password }) {
    const TEACHER_REGISTRATION_PASSWORD = "mtlgap2025";
    if (!username || !password) throw new Error('Username and password are required.');
    if (password !== TEACHER_REGISTRATION_PASSWORD) throw new Error('Invalid registration password.');
    if (await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } })) throw new Error('Username already exists.');
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const role = 'teacher';
    await collection.insertOne({ username, hashedPassword, role, cash: 0, stocks: [], achievements: [], teacherId: null });
    return { success: true };
}

async function loginUser(collection, { username, password }) {
    const user = await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (!user) throw new Error('Invalid credentials.');
    const isMatch = await bcrypt.compare(password, user.hashedPassword);
    if (!isMatch) throw new Error('Invalid credentials.');
    const token = jwt.sign({ userId: user._id.toString(), username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h' });
    return { token, userData: { userId: user._id.toString(), username: user.username, role: user.role } };
}

// --- TEACHER & ROSTER ---
async function addStudent(collection, { username, password, startingCash, teacherId }) {
    if (await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } })) throw new Error('Username already exists.');
    const hashedPassword = await bcrypt.hash(password, 10);
    const { insertedId } = await collection.insertOne({ username, hashedPassword, role: 'student', cash: startingCash || 100000, stocks: [], achievements: [], teacherId: teacherId });
    return { _id: insertedId, username, cash: startingCash || 100000 };
}

async function getStudentRoster(collection, teacherId) { 
    return await collection.find({ $or: [{ teacherId: teacherId }, { teacherId: new ObjectId(teacherId) }] }).project({ hashedPassword: 0 }).toArray(); 
}
async function removeStudent(collection, studentId, teacherId) { 
    const result = await collection.deleteOne({ _id: new ObjectId(studentId), $or: [{ teacherId: teacherId }, { teacherId: new ObjectId(teacherId) }] }); 
    if (result.deletedCount === 0) throw new Error('Student not found or not under your roster.'); 
    return { success: true }; 
}
async function updateStudentCash(collection, studentId, amount, teacherId) { 
    const result = await collection.updateOne({ _id: new ObjectId(studentId), $or: [{ teacherId: teacherId }, { teacherId: new ObjectId(teacherId) }] }, { $inc: { cash: amount } }); 
    if (result.matchedCount === 0) throw new Error('Student not found or not under your roster.'); 
    return { success: true }; 
}
async function updateTeacherCash(collection, teacherId, amount) { 
    const result = await collection.updateOne({ _id: new ObjectId(teacherId), role: 'teacher' }, { $inc: { cash: amount } }); 
    if (result.matchedCount === 0) throw new Error('Teacher not found.'); 
    const updatedUser = await collection.findOne({ _id: new ObjectId(teacherId) }); 
    return { newCashBalance: updatedUser.cash }; 
}
async function updateStudentCredentials(collection, studentId, teacherId, newUsername, newPassword) {
    const updateQuery = {};
    if (newUsername) {
        const existing = await collection.findOne({ username: { $regex: new RegExp(`^${newUsername}$`, 'i') } });
        if (existing && !existing._id.equals(new ObjectId(studentId))) throw new Error("Username is already taken.");
        updateQuery.username = newUsername;
    }
    if (newPassword) updateQuery.hashedPassword = await bcrypt.hash(newPassword, 10);
    if (Object.keys(updateQuery).length === 0) throw new Error("No changes were provided.");
    const result = await collection.updateOne({ _id: new ObjectId(studentId), $or: [{ teacherId: teacherId }, { teacherId: new ObjectId(teacherId) }] }, { $set: updateQuery });
    if (result.matchedCount === 0) throw new Error('Student not found or not under your roster.');
    return { success: true };
}

// --- PORTFOLIO & TRADING ---
async function getPortfolio(collection, userId) {
    const user = await collection.findOne({ _id: new ObjectId(userId) }, { projection: { cash: 1, stocks: 1, achievements: 1 } });
    if (!user) throw new Error('User not found.');
    return user;
}

async function executeTrade(collection, userId, { type, symbol, quantity, price }) {
    const user = await collection.findOne({ _id: new ObjectId(userId) });
    if (!user) throw new Error('User not found.');
    let { cash, stocks, achievements } = user;
    stocks = stocks || [];
    achievements = achievements || [];
    if (type === 'buy') {
        if (quantity * price > cash) throw new Error('Not enough cash.');
        cash -= quantity * price;
        const stock = stocks.find(s => s.symbol === symbol);
        if (stock) {
            stock.purchasePrice = ((stock.shares * stock.purchasePrice) + (quantity * price)) / (stock.shares + quantity);
            stock.shares += quantity;
        } else {
            stocks.push({ symbol, shares: quantity, purchasePrice: price, purchaseDate: Math.floor(Date.now() / 1000) });
        }
    } else if (type === 'sell') {
        const stock = stocks.find(s => s.symbol === symbol);
        if (!stock || stock.shares < quantity) throw new Error('Not enough shares to sell.');
        if (price > stock.purchasePrice && !achievements.includes('PROFIT_MAKER')) achievements.push('PROFIT_MAKER');
        cash += quantity * price;
        stock.shares -= quantity;
        if (stock.shares === 0) stocks = stocks.filter(s => s.symbol !== symbol);
    } else {
        throw new Error('Invalid trade type.');
    }
    if (!achievements.includes('FIRST_TRADE')) achievements.push('FIRST_TRADE');
    await collection.updateOne({ _id: new ObjectId(userId) }, { $set: { cash, stocks, achievements } });
    const newPortfolio = await getPortfolio(collection, userId);
    return { success: true, newPortfolio };
}

// --- LEADERBOARD & ACHIEVEMENTS ---
async function getLeaderboards(usersCollection, currentUser) {
    const allUsers = await usersCollection.find({}, { projection: { username: 1, cash: 1, stocks: 1, teacherId: 1, role: 1 } }).toArray();
    const allSymbols = [...new Set(allUsers.flatMap(u => u.stocks ? u.stocks.map(s => s.symbol) : []))];
    let quotes = {};
    if (allSymbols.length > 0) quotes = await getQuotes(allSymbols);
    const rankedUsers = allUsers.map(user => {
        let stockValue = 0;
        if (user.stocks) user.stocks.forEach(stock => { stockValue += stock.shares * (quotes[stock.symbol] ? quotes[stock.symbol].c : stock.purchasePrice); });
        return { ...user, totalValue: user.cash + stockValue };
    }).sort((a, b) => b.totalValue - a.totalValue);
    const global = rankedUsers;
    let classLeaderboard = [];
    if (currentUser.role === 'teacher') {
        const teacherId = currentUser.userId;
        classLeaderboard = rankedUsers.filter(user => user._id.toString() === teacherId || (user.teacherId && (user.teacherId.toString() === teacherId)));
    } else {
        const student = allUsers.find(u => u._id.toString() === currentUser.userId);
        if (student && student.teacherId) {
            const teacherIdStr = student.teacherId.toString();
            classLeaderboard = rankedUsers.filter(user => (user.teacherId && user.teacherId.toString() === teacherIdStr) || user._id.toString() === teacherIdStr);
        } else {
            classLeaderboard = rankedUsers.filter(user => user._id.toString() === currentUser.userId);
        }
    }
    return { global, class: classLeaderboard };
}

async function checkAndAwardAchievements(db, userId) {
    const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) return { newAchievements: [] };
    let { achievements, stocks, cash } = user;
    achievements = achievements || [];
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
    if (!achievements.includes('PATIENT_INVESTOR') && stocks.some(s => s.purchaseDate < thirtyDaysAgo)) achievements.push('PATIENT_INVESTOR');
    let totalValue = cash;
    const allSymbols = stocks.map(s => s.symbol);
    if (allSymbols.length > 0) {
        const quotes = await getQuotes(allSymbols);
        stocks.forEach(stock => { totalValue += stock.shares * (quotes[stock.symbol] ? quotes[stock.symbol].c : stock.purchasePrice); });
    }
    if (!achievements.includes('MARKET_MASTER') && totalValue >= 125000) achievements.push('MARKET_MASTER');
    if (!achievements.includes('DIVERSIFIED_INVESTOR') && stocks.length >= 3) {
        const industryData = await getStockIndustries(allSymbols);
        const industries = new Set(Object.values(industryData));
        if (industries.size >= 3) achievements.push('DIVERSIFIED_INVESTOR');
    }
    await db.collection('users').updateOne({ _id: user._id }, { $set: { achievements } });
    return { newAchievements: achievements };
}

// --- FMP DATA PROXY ---
async function fmpApiCall(endpoint, params = {}) {
    const apiKey = process.env.FMP_API_KEY;
    if (!apiKey) throw new Error('FMP API key not configured on server.');
    const query = new URLSearchParams({ ...params, apikey: apiKey }).toString();
    const url = `https://financialmodelingprep.com/api/v3/${endpoint}?${query}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch data from FMP: ${response.statusText}`);
    const data = await response.json();
    if (data["Error Message"]) throw new Error(data["Error Message"]);
    return data;
}
async function getQuotes(symbols) { const data = await fmpApiCall(`quote/${symbols.join(',')}`); const quotes = {}; data.forEach(q => { quotes[q.symbol] = { c: q.price }; }); return quotes; }
async function getCompanyNews(cacheCollection, symbols) {
    const data = await fmpApiCall(`stock_news`, { tickers: symbols.join(','), limit: 10 });
    let allNews = data || [];
    const headlines = allNews.map(n => n.title);
    const cachedItems = await cacheCollection.find({ headline: { $in: headlines } }).toArray();
    const cacheMap = new Map(cachedItems.map(item => [item.headline, item.simplifiedText]));
    allNews.forEach(newsItem => { if (cacheMap.has(newsItem.title)) newsItem.simplifiedText = cacheMap.get(newsItem.title); newsItem.headline = newsItem.title; newsItem.summary = newsItem.text; newsItem.datetime = new Date(newsItem.publishedDate).getTime() / 1000; newsItem.id = newsItem.url; });
    return allNews;
}
async function getChartData(symbol) { const data = await fmpApiCall(`historical-price-full/${symbol}`, { serietype: 'line' }); if (!data.historical) throw new Error("No chart data available."); const historical = data.historical.reverse(); return { c: historical.map(d => d.close), t: historical.map(d => new Date(d.date).getTime() / 1000), s: 'ok' }; }
async function getStockIndustries(symbols) {
    const profiles = await Promise.all(symbols.map(s => fmpApiCall(`profile/${s}`)));
    const industries = {};
    profiles.flat().forEach(p => { if (p && p.symbol) { industries[p.symbol] = p.industry || 'Other'; } });
    return industries;
}

// --- AI-POWERED FUNCTIONS (OPENAI) ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function intelligentSearch(query) {
    // 1. Direct FMP Search
    let fmpResults = [];
    try {
        fmpResults = await fmpApiCall('search', { query, limit: 5, exchange: 'NASDAQ,NYSE' });
    } catch (error) {
        console.error("FMP search failed:", error);
        // Don't throw, continue to AI search
    }

    // Prepare results in the desired format
    let combinedResults = (fmpResults || []).map(r => ({ symbol: r.symbol, description: r.name }));

    // 2. AI Search if FMP results are limited or query is conceptual
    // Let's assume conceptual if query is multiple words or FMP returned < 2 results
    if ((fmpResults.length < 2 || query.includes(' ')) && process.env.OPENAI_API_KEY) {
        try {
            const completion = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: "You are a financial assistant. Based on the user's query (product, industry, concept, company name), list up to 5 relevant stock ticker symbols on major US exchanges, separated by commas. ONLY output the comma-separated symbols." },
                    { role: 'user', content: `Query: "${query}"` }
                ],
                temperature: 0.1,
                max_tokens: 50,
            });

            const aiSymbols = completion.choices[0].message.content.trim().toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
            
            if (aiSymbols.length > 0) {
                // Fetch details for AI symbols from FMP
                const aiDetails = await Promise.all(
                    aiSymbols.map(symbol => fmpApiCall('search', { query: symbol, limit: 1, exchange: 'NASDAQ,NYSE' }))
                );
                
                // Flatten, filter, and format AI results
                const aiFormattedResults = aiDetails
                    .flat() // Flatten the array of arrays
                    .filter(r => r && aiSymbols.includes(r.symbol)) // Ensure we only get the symbols AI suggested
                    .map(r => ({ symbol: r.symbol, description: r.name }));

                // Combine and deduplicate
                const uniqueSymbols = new Set(combinedResults.map(r => r.symbol));
                aiFormattedResults.forEach(r => {
                    if (!uniqueSymbols.has(r.symbol)) {
                        combinedResults.push(r);
                        uniqueSymbols.add(r.symbol);
                    }
                });
            }
        } catch (aiError) {
            console.error("OpenAI search enhancement failed:", aiError);
            // Proceed with FMP results only
        }
    }

    // Limit total results
    return combinedResults.slice(0, 10);
}

async function getCompanyExplanation(cacheCollection, companyName, symbol) {
    const cached = await cacheCollection.findOne({ symbol });
    if (cached) return { explanation: cached.explanation };
    const completion = await openai.chat.completions.create({ model: 'gpt-3.5-turbo', messages: [{ role: 'system', content: "You are a financial analyst explaining a company to a 4th grader. Your tone is simple, direct, and informative. First, state what goods/services the company sells. Second, make a brief, neutral statement about its recent performance (e.g., 'the stock has grown' or 'has faced challenges'). Finally, state a potential reason to consider investing and a potential risk, without giving direct advice. Output only the explanation." }, { role: 'user', content: `Explain "${companyName}" (${symbol}).` }], });
    const explanation = completion.choices[0].message.content.trim();
    await cacheCollection.updateOne({ symbol }, { $set: { explanation } }, { upsert: true });
    return { explanation };
}
async function simplifyNews(headline, summary) { const completion = await openai.chat.completions.create({ model: 'gpt-3.5-turbo', messages: [{ role: 'system', content: "You are an expert at simplifying financial news for a 4th grader. Rewrite the following news summary in simple, easy-to-understand language. Explain what it means for the company. Output only the simplified text." }, { role: 'user', content: `Headline: ${headline}\nSummary: ${summary}` }], }); return { simplifiedText: completion.choices[0].message.content.trim() }; }
async function getPortfolioAnalysis(username, portfolioSummary) { const completion = await openai.chat.completions.create({ model: 'gpt-3.5-turbo', messages: [{ role: 'system', content: "You are a friendly financial coach for kids. Look at the student's portfolio and provide simple, positive feedback. Explain concepts like diversification and performance in easy terms. DO NOT give financial advice. Keep it to 2-3 short paragraphs. Address the student by name." }, { role: 'user', content: `Here is ${username}'s portfolio summary: ${JSON.stringify(portfolioSummary)}. Please provide a simple analysis.` }], }); return { analysis: completion.choices[0].message.content.trim() }; }
