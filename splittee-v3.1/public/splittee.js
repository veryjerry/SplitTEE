/**
 * Split Tee v2.1 - Embeddable SDK
 * Add split payments to any golf course booking page
 * 
 * Usage:
 * <script src="https://splittee.com/sdk/splittee.js" data-course="pine-valley"></script>
 * <button data-splittee-trigger>Split Payment</button>
 */

(function(window, document) {
    'use strict';

    const SPLITTEE_VERSION = '2.1.0';
    const API_BASE = window.SPLITTEE_API_BASE || 'https://api.splittee.com';
    
    // ============================================
    // STYLES
    // ============================================
    
    const STYLES = `
        .splittee-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.3s, visibility 0.3s;
        }
        .splittee-overlay.active {
            opacity: 1;
            visibility: visible;
        }
        .splittee-modal {
            background: #fff;
            border-radius: 16px;
            max-width: 480px;
            width: 95%;
            max-height: 90vh;
            overflow: hidden;
            transform: translateY(20px);
            transition: transform 0.3s;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
        }
        .splittee-overlay.active .splittee-modal {
            transform: translateY(0);
        }
        .splittee-header {
            background: #1B4332;
            color: white;
            padding: 20px 24px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .splittee-header h2 {
            margin: 0;
            font-size: 20px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .splittee-close {
            background: none;
            border: none;
            color: white;
            font-size: 28px;
            cursor: pointer;
            padding: 0;
            line-height: 1;
            opacity: 0.8;
        }
        .splittee-close:hover {
            opacity: 1;
        }
        .splittee-content {
            padding: 24px;
            overflow-y: auto;
            max-height: calc(90vh - 140px);
        }
        .splittee-step {
            display: none;
        }
        .splittee-step.active {
            display: block;
        }
        .splittee-field {
            margin-bottom: 16px;
        }
        .splittee-label {
            display: block;
            font-size: 14px;
            font-weight: 500;
            color: #374151;
            margin-bottom: 6px;
        }
        .splittee-input {
            width: 100%;
            padding: 12px 14px;
            border: 2px solid #E5E7EB;
            border-radius: 8px;
            font-size: 16px;
            transition: border-color 0.2s;
            box-sizing: border-box;
        }
        .splittee-input:focus {
            outline: none;
            border-color: #1B4332;
        }
        .splittee-row {
            display: flex;
            gap: 12px;
        }
        .splittee-row .splittee-field {
            flex: 1;
        }
        .splittee-players-list {
            border: 2px solid #E5E7EB;
            border-radius: 8px;
            overflow: hidden;
        }
        .splittee-player {
            padding: 12px 14px;
            border-bottom: 1px solid #E5E7EB;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .splittee-player:last-child {
            border-bottom: none;
        }
        .splittee-player-num {
            width: 28px;
            height: 28px;
            background: #1B4332;
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: 600;
            flex-shrink: 0;
        }
        .splittee-player-inputs {
            flex: 1;
            display: flex;
            gap: 8px;
        }
        .splittee-player-input {
            flex: 1;
            padding: 8px 10px;
            border: 1px solid #D1D5DB;
            border-radius: 6px;
            font-size: 14px;
        }
        .splittee-player-input:focus {
            outline: none;
            border-color: #1B4332;
        }
        .splittee-player-remove {
            background: none;
            border: none;
            color: #9CA3AF;
            cursor: pointer;
            padding: 4px;
            font-size: 18px;
        }
        .splittee-player-remove:hover {
            color: #DC2626;
        }
        .splittee-add-player {
            width: 100%;
            padding: 12px;
            background: #F3F4F6;
            border: 2px dashed #D1D5DB;
            border-radius: 8px;
            color: #6B7280;
            font-size: 14px;
            cursor: pointer;
            margin-top: 12px;
            transition: all 0.2s;
        }
        .splittee-add-player:hover {
            background: #E5E7EB;
            border-color: #9CA3AF;
        }
        .splittee-add-player:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .splittee-summary {
            background: #F9FAFB;
            border-radius: 8px;
            padding: 16px;
            margin: 16px 0;
        }
        .splittee-summary-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            font-size: 14px;
            color: #6B7280;
        }
        .splittee-summary-row.total {
            border-top: 2px solid #E5E7EB;
            margin-top: 8px;
            padding-top: 12px;
            font-size: 18px;
            font-weight: 600;
            color: #1B4332;
        }
        .splittee-btn {
            width: 100%;
            padding: 14px 24px;
            background: #1B4332;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
        }
        .splittee-btn:hover {
            background: #14532D;
        }
        .splittee-btn:disabled {
            background: #9CA3AF;
            cursor: not-allowed;
        }
        .splittee-btn-secondary {
            background: white;
            color: #1B4332;
            border: 2px solid #1B4332;
        }
        .splittee-btn-secondary:hover {
            background: #D8F3DC;
        }
        .splittee-error {
            background: #FEF2F2;
            color: #DC2626;
            padding: 12px;
            border-radius: 8px;
            font-size: 14px;
            margin-bottom: 16px;
        }
        .splittee-success {
            text-align: center;
            padding: 24px;
        }
        .splittee-success-icon {
            width: 64px;
            height: 64px;
            background: #D8F3DC;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 16px;
            font-size: 32px;
        }
        .splittee-success h3 {
            margin: 0 0 8px;
            font-size: 20px;
            color: #1B4332;
        }
        .splittee-success p {
            color: #6B7280;
            margin: 0;
        }
        .splittee-powered {
            text-align: center;
            padding: 12px;
            font-size: 12px;
            color: #9CA3AF;
            border-top: 1px solid #E5E7EB;
        }
        .splittee-powered a {
            color: #1B4332;
            text-decoration: none;
        }
        @media (max-width: 480px) {
            .splittee-modal {
                width: 100%;
                max-height: 100vh;
                border-radius: 0;
            }
            .splittee-player-inputs {
                flex-direction: column;
            }
        }
    `;

    // ============================================
    // SPLITTEE CLASS
    // ============================================

    class SplitTee {
        constructor(options = {}) {
            this.courseSlug = options.courseSlug || this.getDataAttribute('course');
            this.course = null;
            this.players = [{ name: '', email: '' }, { name: '', email: '' }];
            this.teeDate = options.teeDate || '';
            this.teeTime = options.teeTime || '';
            this.greenFee = options.greenFee || 0;
            this.cartFee = options.cartFee || 0;
            this.pricing = null;
            this.currentStep = 1;
            this.overlay = null;
            
            this.init();
        }

        getDataAttribute(name) {
            const script = document.querySelector('script[data-course]');
            return script ? script.getAttribute(`data-${name}`) : null;
        }

        async init() {
            this.injectStyles();
            this.createModal();
            this.bindTriggers();
            
            if (this.courseSlug) {
                await this.loadCourse();
            }
        }

        injectStyles() {
            if (document.getElementById('splittee-styles')) return;
            
            const style = document.createElement('style');
            style.id = 'splittee-styles';
            style.textContent = STYLES;
            document.head.appendChild(style);
        }

        createModal() {
            this.overlay = document.createElement('div');
            this.overlay.className = 'splittee-overlay';
            this.overlay.innerHTML = `
                <div class="splittee-modal">
                    <div class="splittee-header">
                        <h2>⛳ Split Payment</h2>
                        <button class="splittee-close">&times;</button>
                    </div>
                    <div class="splittee-content">
                        <div class="splittee-error" style="display:none;"></div>
                        
                        <!-- Step 1: Tee Time Details -->
                        <div class="splittee-step active" data-step="1">
                            <div class="splittee-field">
                                <label class="splittee-label">Course</label>
                                <input type="text" class="splittee-input" id="splittee-course" readonly>
                            </div>
                            <div class="splittee-row">
                                <div class="splittee-field">
                                    <label class="splittee-label">Tee Date</label>
                                    <input type="date" class="splittee-input" id="splittee-date">
                                </div>
                                <div class="splittee-field">
                                    <label class="splittee-label">Tee Time</label>
                                    <input type="time" class="splittee-input" id="splittee-time">
                                </div>
                            </div>
                            <div class="splittee-row">
                                <div class="splittee-field">
                                    <label class="splittee-label">Green Fee ($)</label>
                                    <input type="number" class="splittee-input" id="splittee-green-fee" min="0" step="0.01">
                                </div>
                                <div class="splittee-field">
                                    <label class="splittee-label">Cart Fee ($)</label>
                                    <input type="number" class="splittee-input" id="splittee-cart-fee" min="0" step="0.01" value="0">
                                </div>
                            </div>
                            <button class="splittee-btn" id="splittee-next-1">Next: Add Players →</button>
                        </div>
                        
                        <!-- Step 2: Add Players -->
                        <div class="splittee-step" data-step="2">
                            <p style="margin:0 0 16px;color:#6B7280;">Add everyone in your group. Each person will receive a payment link.</p>
                            
                            <div class="splittee-field">
                                <label class="splittee-label">Your Info (Booker)</label>
                                <div class="splittee-row">
                                    <input type="text" class="splittee-input" id="splittee-booker-name" placeholder="Your name">
                                    <input type="email" class="splittee-input" id="splittee-booker-email" placeholder="Your email">
                                </div>
                            </div>
                            
                            <label class="splittee-label">Other Players</label>
                            <div class="splittee-players-list" id="splittee-players"></div>
                            <button class="splittee-add-player" id="splittee-add-player">+ Add Another Player</button>
                            
                            <div style="display:flex;gap:12px;margin-top:20px;">
                                <button class="splittee-btn splittee-btn-secondary" id="splittee-back-2">← Back</button>
                                <button class="splittee-btn" id="splittee-next-2">Review & Send →</button>
                            </div>
                        </div>
                        
                        <!-- Step 3: Review & Confirm -->
                        <div class="splittee-step" data-step="3">
                            <div class="splittee-summary" id="splittee-review"></div>
                            
                            <p style="font-size:14px;color:#6B7280;margin:16px 0;">
                                ⏱️ Once you send invites, players have <strong>10 minutes</strong> from the first payment to complete all payments. If not everyone pays in time, all payments are automatically refunded.
                            </p>
                            
                            <div style="display:flex;gap:12px;">
                                <button class="splittee-btn splittee-btn-secondary" id="splittee-back-3">← Back</button>
                                <button class="splittee-btn" id="splittee-submit">Send Payment Links ✉️</button>
                            </div>
                        </div>
                        
                        <!-- Step 4: Success -->
                        <div class="splittee-step" data-step="4">
                            <div class="splittee-success">
                                <div class="splittee-success-icon">✅</div>
                                <h3>Payment Links Sent!</h3>
                                <p>Everyone in your group has received an email with their payment link.</p>
                                <p style="margin-top:16px;"><strong>Confirmation:</strong> <span id="splittee-code"></span></p>
                            </div>
                            <button class="splittee-btn" id="splittee-done">Done</button>
                        </div>
                    </div>
                    <div class="splittee-powered">
                        Powered by <a href="https://splittee.com" target="_blank">Split Tee</a>
                    </div>
                </div>
            `;
            
            document.body.appendChild(this.overlay);
            this.bindModalEvents();
        }

        bindModalEvents() {
            // Close button
            this.overlay.querySelector('.splittee-close').addEventListener('click', () => this.close());
            
            // Overlay click
            this.overlay.addEventListener('click', (e) => {
                if (e.target === this.overlay) this.close();
            });
            
            // Step navigation
            this.overlay.querySelector('#splittee-next-1').addEventListener('click', () => this.goToStep(2));
            this.overlay.querySelector('#splittee-back-2').addEventListener('click', () => this.goToStep(1));
            this.overlay.querySelector('#splittee-next-2').addEventListener('click', () => this.goToStep(3));
            this.overlay.querySelector('#splittee-back-3').addEventListener('click', () => this.goToStep(2));
            this.overlay.querySelector('#splittee-submit').addEventListener('click', () => this.submit());
            this.overlay.querySelector('#splittee-done').addEventListener('click', () => this.close());
            
            // Add player
            this.overlay.querySelector('#splittee-add-player').addEventListener('click', () => this.addPlayer());
            
            // Price updates
            ['splittee-green-fee', 'splittee-cart-fee'].forEach(id => {
                this.overlay.querySelector(`#${id}`).addEventListener('change', () => this.updatePricing());
            });
        }

        bindTriggers() {
            document.querySelectorAll('[data-splittee-trigger]').forEach(el => {
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    
                    // Get data from trigger element
                    const data = el.dataset;
                    if (data.teeDate) this.teeDate = data.teeDate;
                    if (data.teeTime) this.teeTime = data.teeTime;
                    if (data.greenFee) this.greenFee = parseFloat(data.greenFee);
                    if (data.cartFee) this.cartFee = parseFloat(data.cartFee);
                    
                    this.open();
                });
            });
        }

        async loadCourse() {
            try {
                const res = await fetch(`${API_BASE}/api/v1/courses/${this.courseSlug}/embed`);
                if (!res.ok) throw new Error('Course not found');
                
                this.course = await res.json();
                
                if (!this.greenFee && this.course.defaultGreenFee) {
                    this.greenFee = parseFloat(this.course.defaultGreenFee);
                }
                if (!this.cartFee && this.course.defaultCartFee) {
                    this.cartFee = parseFloat(this.course.defaultCartFee);
                }
            } catch (error) {
                console.error('SplitTee: Failed to load course', error);
            }
        }

        async updatePricing() {
            const greenFee = parseFloat(this.overlay.querySelector('#splittee-green-fee').value) || 0;
            const cartFee = parseFloat(this.overlay.querySelector('#splittee-cart-fee').value) || 0;
            
            try {
                const res = await fetch(`${API_BASE}/api/v1/pricing/calculate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ greenFee, cartFee })
                });
                
                this.pricing = await res.json();
            } catch (error) {
                console.error('SplitTee: Failed to calculate pricing', error);
            }
        }

        open() {
            this.currentStep = 1;
            this.showStep(1);
            this.populateForm();
            this.overlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        }

        close() {
            this.overlay.classList.remove('active');
            document.body.style.overflow = '';
            this.resetForm();
        }

        populateForm() {
            if (this.course) {
                this.overlay.querySelector('#splittee-course').value = this.course.name;
            }
            if (this.teeDate) {
                this.overlay.querySelector('#splittee-date').value = this.teeDate;
            }
            if (this.teeTime) {
                this.overlay.querySelector('#splittee-time').value = this.teeTime;
            }
            if (this.greenFee) {
                this.overlay.querySelector('#splittee-green-fee').value = this.greenFee;
            }
            if (this.cartFee) {
                this.overlay.querySelector('#splittee-cart-fee').value = this.cartFee;
            }
            
            this.updatePricing();
            this.renderPlayers();
        }

        resetForm() {
            this.players = [{ name: '', email: '' }, { name: '', email: '' }];
            this.hideError();
        }

        showStep(step) {
            this.overlay.querySelectorAll('.splittee-step').forEach(el => {
                el.classList.remove('active');
            });
            this.overlay.querySelector(`[data-step="${step}"]`).classList.add('active');
            this.currentStep = step;
        }

        goToStep(step) {
            // Validate current step
            if (step > this.currentStep) {
                if (!this.validateStep(this.currentStep)) return;
            }
            
            // Prepare next step
            if (step === 3) {
                this.renderReview();
            }
            
            this.showStep(step);
        }

        validateStep(step) {
            this.hideError();
            
            if (step === 1) {
                const date = this.overlay.querySelector('#splittee-date').value;
                const time = this.overlay.querySelector('#splittee-time').value;
                const greenFee = this.overlay.querySelector('#splittee-green-fee').value;
                
                if (!date) return this.showError('Please select a tee date');
                if (!time) return this.showError('Please select a tee time');
                if (!greenFee || parseFloat(greenFee) <= 0) return this.showError('Please enter the green fee');
                
                // Check date is in future
                if (new Date(date) < new Date().setHours(0,0,0,0)) {
                    return this.showError('Tee date must be in the future');
                }
            }
            
            if (step === 2) {
                const bookerName = this.overlay.querySelector('#splittee-booker-name').value.trim();
                const bookerEmail = this.overlay.querySelector('#splittee-booker-email').value.trim();
                
                if (!bookerName) return this.showError('Please enter your name');
                if (!bookerEmail || !this.isValidEmail(bookerEmail)) {
                    return this.showError('Please enter a valid email');
                }
                
                // Collect player data
                this.collectPlayerData();
                
                if (this.players.length < 1) {
                    return this.showError('Please add at least one other player');
                }
                
                // Validate all players have email
                for (let i = 0; i < this.players.length; i++) {
                    if (!this.players[i].email || !this.isValidEmail(this.players[i].email)) {
                        return this.showError(`Player ${i + 2} needs a valid email`);
                    }
                }
                
                // Check for duplicate emails
                const emails = [bookerEmail, ...this.players.map(p => p.email.toLowerCase())];
                if (new Set(emails).size !== emails.length) {
                    return this.showError('Each player must have a unique email');
                }
            }
            
            return true;
        }

        collectPlayerData() {
            const playerEls = this.overlay.querySelectorAll('.splittee-player');
            this.players = Array.from(playerEls).map(el => ({
                name: el.querySelector('.player-name').value.trim(),
                email: el.querySelector('.player-email').value.trim()
            }));
        }

        renderPlayers() {
            const container = this.overlay.querySelector('#splittee-players');
            container.innerHTML = this.players.map((player, i) => `
                <div class="splittee-player" data-index="${i}">
                    <div class="splittee-player-num">${i + 2}</div>
                    <div class="splittee-player-inputs">
                        <input type="text" class="splittee-player-input player-name" placeholder="Name" value="${player.name}">
                        <input type="email" class="splittee-player-input player-email" placeholder="Email" value="${player.email}">
                    </div>
                    ${this.players.length > 1 ? `<button class="splittee-player-remove" data-index="${i}">&times;</button>` : ''}
                </div>
            `).join('');
            
            // Bind remove buttons
            container.querySelectorAll('.splittee-player-remove').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const idx = parseInt(e.target.dataset.index);
                    this.collectPlayerData();
                    this.players.splice(idx, 1);
                    this.renderPlayers();
                });
            });
            
            // Update add button
            const addBtn = this.overlay.querySelector('#splittee-add-player');
            addBtn.disabled = this.players.length >= 7; // Max 8 total including booker
        }

        addPlayer() {
            if (this.players.length >= 7) return;
            this.collectPlayerData();
            this.players.push({ name: '', email: '' });
            this.renderPlayers();
        }

        renderReview() {
            const bookerName = this.overlay.querySelector('#splittee-booker-name').value;
            const bookerEmail = this.overlay.querySelector('#splittee-booker-email').value;
            const date = this.overlay.querySelector('#splittee-date').value;
            const time = this.overlay.querySelector('#splittee-time').value;
            const numPlayers = this.players.length + 1;
            
            const allPlayers = [
                { name: bookerName, email: bookerEmail, isBooker: true },
                ...this.players
            ];
            
            const dateFormatted = new Date(date).toLocaleDateString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric'
            });
            
            const timeFormatted = this.formatTime(time);
            
            const container = this.overlay.querySelector('#splittee-review');
            container.innerHTML = `
                <div style="margin-bottom:16px;">
                    <strong>${this.course?.name || 'Golf Course'}</strong><br>
                    📅 ${dateFormatted} at ${timeFormatted}
                </div>
                
                <div style="margin-bottom:16px;">
                    <strong>Players (${numPlayers})</strong>
                    ${allPlayers.map(p => `
                        <div style="padding:4px 0;font-size:14px;">
                            ${p.name || 'Guest'} ${p.isBooker ? '(You)' : ''} - ${p.email}
                        </div>
                    `).join('')}
                </div>
                
                <div class="splittee-summary-row">
                    <span>Green Fee</span>
                    <span>$${this.pricing?.basePrice?.toFixed(2) || '0.00'}</span>
                </div>
                <div class="splittee-summary-row">
                    <span>Convenience Fee</span>
                    <span>$${this.pricing?.platformFee?.toFixed(2) || '0.00'}</span>
                </div>
                <div class="splittee-summary-row total">
                    <span>Per Player</span>
                    <span>$${this.pricing?.totalPerPlayer?.toFixed(2) || '0.00'}</span>
                </div>
            `;
        }

        async submit() {
            const submitBtn = this.overlay.querySelector('#splittee-submit');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Sending...';
            
            try {
                const bookerName = this.overlay.querySelector('#splittee-booker-name').value.trim();
                const bookerEmail = this.overlay.querySelector('#splittee-booker-email').value.trim();
                const teeDate = this.overlay.querySelector('#splittee-date').value;
                const teeTime = this.overlay.querySelector('#splittee-time').value;
                const greenFee = parseFloat(this.overlay.querySelector('#splittee-green-fee').value);
                const cartFee = parseFloat(this.overlay.querySelector('#splittee-cart-fee').value) || 0;
                
                const allPlayers = [
                    { name: bookerName, email: bookerEmail },
                    ...this.players
                ];
                
                const res = await fetch(`${API_BASE}/api/v1/embed/splits`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        courseSlug: this.courseSlug,
                        teeDate,
                        teeTime,
                        greenFee,
                        cartFee,
                        players: allPlayers,
                        bookerName,
                        bookerEmail
                    })
                });
                
                const data = await res.json();
                
                if (!res.ok) {
                    throw new Error(data.error || 'Failed to create split');
                }
                
                // Show success
                this.overlay.querySelector('#splittee-code').textContent = data.split.shortCode;
                this.showStep(4);
                
                // Dispatch success event
                window.dispatchEvent(new CustomEvent('splittee:success', { detail: data }));
                
            } catch (error) {
                this.showError(error.message);
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Send Payment Links ✉️';
            }
        }

        showError(message) {
            const errorEl = this.overlay.querySelector('.splittee-error');
            errorEl.textContent = message;
            errorEl.style.display = 'block';
            return false;
        }

        hideError() {
            this.overlay.querySelector('.splittee-error').style.display = 'none';
        }

        isValidEmail(email) {
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        }

        formatTime(time) {
            const [hours, minutes] = time.split(':');
            const hour = parseInt(hours);
            const ampm = hour >= 12 ? 'PM' : 'AM';
            const hour12 = hour % 12 || 12;
            return `${hour12}:${minutes} ${ampm}`;
        }
    }

    // ============================================
    // AUTO-INIT
    // ============================================

    // Expose globally
    window.SplitTee = SplitTee;

    // Auto-initialize if data attributes present
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new SplitTee());
    } else {
        new SplitTee();
    }

})(window, document);
