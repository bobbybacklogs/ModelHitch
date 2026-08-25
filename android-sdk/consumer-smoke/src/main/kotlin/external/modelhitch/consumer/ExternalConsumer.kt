package external.modelhitch.consumer

import android.content.Context
import com.genoventureslabs.modelhitch.ChatRequest
import com.genoventureslabs.modelhitch.DefaultProviders
import com.genoventureslabs.modelhitch.MessageContent
import com.genoventureslabs.modelhitch.ModelHitch
import com.genoventureslabs.modelhitch.ModelMessage
import com.genoventureslabs.modelhitch.StreamChunk
import com.genoventureslabs.modelhitch.android.AndroidKeyStoreCredentialStore
import kotlinx.coroutines.flow.Flow

class ExternalConsumer(context: Context) {
    private val client = ModelHitch(
        providers = DefaultProviders.all,
        keyStore = AndroidKeyStoreCredentialStore(context),
    )

    suspend fun stream(providerId: String, modelId: String, prompt: String): Flow<StreamChunk> =
        client.stream(
            ChatRequest(
                provider = providerId,
                model = modelId,
                messages = listOf(ModelMessage.User(MessageContent.Text(prompt))),
            ),
        )
}