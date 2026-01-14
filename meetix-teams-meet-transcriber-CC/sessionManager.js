// Gestor de sesiones: maneja el historial de reuniones con gestión de tamaño
// Límites de almacenamiento: chrome.storage.local = 10MB total, 8KB por clave

class SessionManager {
    constructor() {
        this.MAX_SESSIONS = 5;
        this.MAX_CHUNK_SIZE = 7000; // Mantenerse por debajo del límite de 8KB por clave
        this.STORAGE_QUOTA = 8 * 1024 * 1024; // Reservar 8MB para sesiones (dejando 2MB para configuración)
    }

    // Calcula el tamaño aproximado de los datos en bytes
    calculateSize(obj) {
        return new Blob([JSON.stringify(obj)]).size;
    }

    // Divide transcripciones grandes en fragmentos para respetar límites por clave
    chunkTranscript(transcriptArray) {
        const chunks = [];
        let currentChunk = [];
        let currentSize = 0;

        for (const item of transcriptArray) {
            const itemSize = this.calculateSize(item);
            if (currentSize + itemSize > this.MAX_CHUNK_SIZE) {
                chunks.push([...currentChunk]);
                currentChunk = [item];
                currentSize = itemSize;
            } else {
                currentChunk.push(item);
                currentSize += itemSize;
            }
        }
        
        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }
        
        return chunks;
    }

    // Guarda una sesión con chunking, metadatos y limpieza según cuota disponible
    async saveSession(transcriptArray, meetingTitle, attendeeReport = null) {
        try {
            const sessionId = `session_${Date.now()}`;
            const chunks = this.chunkTranscript(transcriptArray);
            
            // Crear metadatos de sesión
            const metadata = {
                id: sessionId,
                title: meetingTitle || 'Untitled Meeting',
                timestamp: new Date().toISOString(),
                date: new Date().toLocaleDateString(),
                time: new Date().toLocaleTimeString(),
                captionCount: transcriptArray.length,
                chunkCount: chunks.length,
                duration: this.calculateDuration(transcriptArray),
                speakers: [...new Set(transcriptArray.map(c => c.Name))].slice(0, 10), // Limit to 10 speakers
                attendees: attendeeReport?.attendeeList?.slice(0, 20), // Limit attendees
                attendeeCount: attendeeReport?.totalUniqueAttendees || 0,
                preview: transcriptArray.slice(0, 3).map(c => `${c.Name}: ${c.Text.substring(0, 50)}`).join(' | '),
                size: this.calculateSize(transcriptArray)
            };

            // Comprobar cuota de almacenamiento antes de guardar
            const currentUsage = await this.getStorageUsage();
            const newDataSize = this.calculateSize(chunks) + this.calculateSize(metadata);
            
            if (currentUsage + newDataSize > this.STORAGE_QUOTA) {
                // Necesario limpiar sesiones antiguas
                await this.cleanupOldSessions(newDataSize);
            }

            // Guardar fragmentos
            const chunkPromises = chunks.map((chunk, index) => 
                chrome.storage.local.set({
                    [`${sessionId}_chunk_${index}`]: chunk
                })
            );
            await Promise.all(chunkPromises);

            // Guardar datos de asistentes si existen
            if (attendeeReport) {
                await chrome.storage.local.set({
                    [`${sessionId}_attendees`]: attendeeReport
                });
            }

            // Actualizar índice de sesiones
            await this.updateSessionIndex(metadata);
            
            console.log(`[SessionManager] Saved session ${sessionId} with ${chunks.length} chunks`);
            return sessionId;
            
        } catch (error) {
            console.error('[SessionManager] Failed to save session:', error);
            throw error;
        }
    }

    // Carga una sesión completa: metadatos, chunks y asistentes si existen
    async loadSession(sessionId) {
        try {
            const index = await this.getSessionIndex();
            const metadata = index.find(s => s.id === sessionId);
            
            if (!metadata) {
                throw new Error('Session not found');
            }

            // Cargar todos los fragmentos
            const chunkKeys = [];
            for (let i = 0; i < metadata.chunkCount; i++) {
                chunkKeys.push(`${sessionId}_chunk_${i}`);
            }
            
            const chunks = await chrome.storage.local.get(chunkKeys);
            const transcriptArray = [];
            
            for (let i = 0; i < metadata.chunkCount; i++) {
                const chunk = chunks[`${sessionId}_chunk_${i}`];
                if (chunk) {
                    transcriptArray.push(...chunk);
                }
            }

            // Cargar datos de asistentes si existen
            const attendeeData = await chrome.storage.local.get(`${sessionId}_attendees`);
            
            return {
                transcript: transcriptArray,
                metadata: metadata,
                attendeeReport: attendeeData[`${sessionId}_attendees`] || null
            };
            
        } catch (error) {
            console.error('[SessionManager] Failed to load session:', error);
            throw error;
        }
    }

    // Elimina una sesión: borra sus chunks, asistentes y actualiza el índice
    async deleteSession(sessionId) {
        try {
            const index = await this.getSessionIndex();
            const metadata = index.find(s => s.id === sessionId);
            
            if (!metadata) return;

            // Eliminar todos los fragmentos
            const keysToDelete = [];
            for (let i = 0; i < metadata.chunkCount; i++) {
                keysToDelete.push(`${sessionId}_chunk_${i}`);
            }
            keysToDelete.push(`${sessionId}_attendees`);
            
            await chrome.storage.local.remove(keysToDelete);
            
            // Actualizar índice
            const newIndex = index.filter(s => s.id !== sessionId);
            await chrome.storage.local.set({ 'session_index': newIndex });
            
            console.log(`[SessionManager] Deleted session ${sessionId}`);
            
        } catch (error) {
            console.error('[SessionManager] Failed to delete session:', error);
        }
    }

    // Devuelve el índice de sesiones guardadas
    async getSessionIndex() {
        const { session_index = [] } = await chrome.storage.local.get('session_index');
        return session_index;
    }

    // Actualiza el índice: inserta metadatos, mantiene máximo y ordena por fecha
    async updateSessionIndex(metadata) {
        let index = await this.getSessionIndex();
        
        // Eliminar cualquier entrada existente con el mismo ID
        index = index.filter(s => s.id !== metadata.id);
        
        // Añadir nuevos metadatos
        index.push(metadata);
        
        // Mantener solo las sesiones recientes
        if (index.length > this.MAX_SESSIONS) {
            // Eliminar las sesiones más antiguas
            const toDelete = index.slice(0, index.length - this.MAX_SESSIONS);
            for (const session of toDelete) {
                await this.deleteSession(session.id);
            }
            index = index.slice(-this.MAX_SESSIONS);
        }
        
        // Ordenar por fecha (más recientes primero)
        index.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        await chrome.storage.local.set({ 'session_index': index });
    }

    // Calcula duración aproximada usando primera y última marca de tiempo
    calculateDuration(transcriptArray) {
        if (transcriptArray.length === 0) return '0 min';
        
        const firstTime = new Date(transcriptArray[0].Time);
        const lastTime = new Date(transcriptArray[transcriptArray.length - 1].Time);
        const durationMs = lastTime - firstTime;
        const minutes = Math.round(durationMs / 60000);
        
        if (minutes < 60) {
            return `${minutes} min`;
        } else {
            const hours = Math.floor(minutes / 60);
            const mins = minutes % 60;
            return `${hours}h ${mins}m`;
        }
    }

    // Calcula uso actual de storage sumando claves `session_*`
    async getStorageUsage() {
        const items = await chrome.storage.local.get(null);
        let totalSize = 0;
        
        for (const key in items) {
            if (key.startsWith('session_')) {
                totalSize += this.calculateSize(items[key]);
            }
        }
        
        return totalSize;
    }

    // Borra sesiones antiguas hasta liberar el espacio requerido
    async cleanupOldSessions(requiredSpace) {
        const index = await this.getSessionIndex();
        let freedSpace = 0;
        
        // Eliminar primero las sesiones más antiguas
        for (const session of index) {
            if (freedSpace >= requiredSpace) break;
            
            freedSpace += session.size || 0;
            await this.deleteSession(session.id);
        }
    }

    // Estadísticas de uso de almacenamiento y conteo de sesiones para UI
    async getStorageStats() {
        const usage = await this.getStorageUsage();
        const index = await this.getSessionIndex();
        
        return {
            usedBytes: usage,
            usedMB: (usage / (1024 * 1024)).toFixed(2),
            quotaMB: (this.STORAGE_QUOTA / (1024 * 1024)).toFixed(2),
            percentUsed: ((usage / this.STORAGE_QUOTA) * 100).toFixed(1),
            sessionCount: index.length,
            oldestSession: index[index.length - 1]?.date || 'N/A',
            newestSession: index[0]?.date || 'N/A'
        };
    }

    // Limpia todas las sesiones y resetea el índice
    async clearAllSessions() {
        const index = await this.getSessionIndex();
        
        for (const session of index) {
            await this.deleteSession(session.id);
        }
        
        await chrome.storage.local.set({ 'session_index': [] });
        console.log('[SessionManager] Cleared all sessions');
    }
}

// Exportar para uso en otros scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionManager;
}
