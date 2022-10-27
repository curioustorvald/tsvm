package net.torvald.tsvm

import com.badlogic.gdx.utils.Json
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import java.math.BigInteger

/**
 * Created by minjaesong on 2022-10-27.
 */
object ProfileSerialiser {

    val jsoner = Json(JsonWriter.OutputType.json)

    init {
        jsoner.ignoreUnknownFields = true
        jsoner.setUsePrototypes(false)
        jsoner.setIgnoreDeprecated(false)

        // BigInteger
        jsoner.setSerializer(BigInteger::class.java, object : Json.Serializer<BigInteger> {
            override fun write(json: Json, obj: BigInteger?, knownType: Class<*>?) {
                json.writeValue(obj?.toString())
            }

            override fun read(json: Json, jsonData: JsonValue, type: Class<*>?): BigInteger? {
                return if (jsonData.isNull) null else BigInteger(jsonData.asString())
            }
        })
        //
    }
}